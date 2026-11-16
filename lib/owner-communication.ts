import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { inventoryClient } from "@/lib/inventory/server";
import { getRecordedOperations } from "@/lib/inventory-sales/operations";
import { finishOrderingApproval } from "@/lib/automation/ordering-cycle";
import { isEmail } from "@/lib/automation/mail-model";
import { createOwnerApprovalToken, verifyOwnerApprovalToken, type OwnerApprovalAction } from "./owner-approval-token";
import { digestSlot, isSydneyRushTime, sydneyDate, sydneyDayBounds, type TimeWindow } from "./owner-communication-model";

type Row = Record<string, unknown>;

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Row;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  return value.trim();
}

function digestAppUrl(): URL {
  const raw = process.env.APP_URL?.trim();
  if (!raw) throw new Error("Set APP_URL before scheduling owner digests.");
  const url = new URL(raw);
  if (url.username || url.password || (url.protocol !== "https:" && url.hostname !== "localhost")) {
    throw new Error("APP_URL must be an HTTPS application URL.");
  }
  return url;
}

function ownerTokenSecret(): string {
  const secret = process.env.OWNER_APPROVAL_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("Set OWNER_APPROVAL_TOKEN_SECRET to at least 32 characters before sending owner digests.");
  }
  return secret;
}

export type OwnerSettings = {
  ownerName: string | null;
  ownerEmail: string | null;
  openTime: string;
  closeTime: string;
  rushWindows: TimeWindow[];
};

async function getOwnerSettings(): Promise<OwnerSettings> {
  const { data, error } = await inventoryClient().from("cafe_settings")
    .select("owner_name,owner_email,open_time,close_time,rush_windows")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error(`Could not load café communication settings: ${error?.message ?? "No settings row returned"}`);
  const settings = row(data, "Café communication settings");
  const rushWindows = Array.isArray(settings.rush_windows)
    ? settings.rush_windows.filter((value): value is TimeWindow => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.start === "string" && typeof candidate.end === "string";
    })
    : [];
  return {
    ownerName: typeof settings.owner_name === "string" && settings.owner_name.trim()
      ? settings.owner_name.trim()
      : null,
    ownerEmail: typeof settings.owner_email === "string" && settings.owner_email.trim()
      ? settings.owner_email.trim()
      : null,
    openTime: text(settings.open_time, "Café opening time").slice(0, 5),
    closeTime: text(settings.close_time, "Café closing time").slice(0, 5),
    rushWindows,
  };
}

export type OwnerNotification = {
  id: string;
  severity: "urgent" | "decision" | "info";
  title: string;
  body: string;
  approvalId: string | null;
  surfaceAfter: string;
};

export async function getOwnerCommunication(date: string, now = new Date()): Promise<{
  settings: OwnerSettings;
  isRush: boolean;
  urgentBadge: boolean;
  notifications: OwnerNotification[];
  decisions: { id: string; summary: string; createdAt: string }[];
  handled: { sales: number | null; deliveries: number | null; orders: number; emails: number };
  activitySummaryAvailable: boolean;
}> {
  const settings = await getOwnerSettings();
  const db = inventoryClient();
  const { start, end } = sydneyDayBounds(date);
  const [notificationResult, approvalResult, operations, orderCount, legacyOrderCount, emailCount] = await Promise.all([
    db.from("owner_notifications")
      .select("id,severity,title,body,approval_id,surface_after")
      .eq("status", "pending")
      .lte("surface_after", now.toISOString())
      .order("severity")
      .order("created_at")
      .limit(50),
    db.from("approval_inbox")
      .select("id,summary,created_at")
      .eq("status", "pending_approval")
      .order("created_at")
      .limit(20),
    getRecordedOperations(date).catch((error: unknown) => {
      console.error("Could not load the owner activity summary:", error instanceof Error ? error.message : "Unknown error");
      return null;
    }),
    db.from("cafe_ordering_cycles").select("cycle_key", { count: "exact", head: true })
      .eq("status", "simulated_order").gte("created_at", start).lt("created_at", end),
    db.from("cafe_sim_orders").select("id", { count: "exact", head: true })
      .eq("status", "submitted").gte("submitted_at", start).lt("submitted_at", end),
    db.from("cafe_test_mail").select("event_id", { count: "exact", head: true })
      .in("status", ["delivered_to_demo", "provider_accepted"])
      .gte("sent_at", start).lt("sent_at", end),
  ]);
  if (notificationResult.error) throw new Error(`Could not load owner notifications: ${notificationResult.error.message}`);
  if (approvalResult.error) throw new Error(`Could not load pending decisions: ${approvalResult.error.message}`);
  if (orderCount.error || legacyOrderCount.error || emailCount.error) {
    throw new Error("Could not load the café's recorded activity summary.");
  }

  const notifications: OwnerNotification[] = (notificationResult.data ?? []).map((value) => {
    const item = row(value, "Owner notification");
    const severity = text(item.severity, "Notification severity");
    if (severity !== "urgent" && severity !== "decision" && severity !== "info") {
      throw new Error("An owner notification has an unsupported severity.");
    }
    return {
      id: text(item.id, "Notification ID"),
      severity,
      title: text(item.title, "Notification title"),
      body: typeof item.body === "string" ? item.body : "",
      approvalId: typeof item.approval_id === "string" ? item.approval_id : null,
      surfaceAfter: text(item.surface_after, "Notification display time"),
    };
  });
  const isRush = isSydneyRushTime(now, settings.rushWindows);
  const visibleNotifications = isRush ? [] : notifications;
  const surfacedApprovalIds = new Set(notifications
    .filter((item) => item.severity === "decision" && item.approvalId)
    .map((item) => item.approvalId as string));
  const decisions = isRush ? [] : (approvalResult.data ?? []).map((value) => {
    const item = row(value, "Pending approval");
    const id = text(item.id, "Approval ID");
    if (!surfacedApprovalIds.has(id)) return null;
    return {
      id,
      summary: text(item.summary, "Approval summary"),
      createdAt: text(item.created_at, "Approval creation time"),
    };
  }).filter((item): item is { id: string; summary: string; createdAt: string } => item !== null).slice(0, 3);

  return {
    settings,
    isRush,
    urgentBadge: isRush && notifications.some((item) => item.severity === "urgent"),
    notifications: visibleNotifications,
    decisions,
    activitySummaryAvailable: operations !== null,
    handled: {
      sales: operations?.transactionCount ?? null,
      deliveries: operations?.deliveriesReceived.length ?? null,
      orders: (orderCount.count ?? 0) + (legacyOrderCount.count ?? 0),
      emails: emailCount.count ?? 0,
    },
  };
}

export async function ownerDockStatus(now = new Date()): Promise<{
  hasBadge: boolean;
  cycleRunning: boolean;
  isRush: boolean;
}> {
  const db = inventoryClient();
  const settings = await getOwnerSettings();
  const isRush = isSydneyRushTime(now, settings.rushWindows);
  let notificationQuery = db.from("owner_notifications")
    .select("id,severity")
    .eq("status", "pending")
    .lte("surface_after", now.toISOString());
  if (isRush) notificationQuery = notificationQuery.eq("severity", "urgent");
  const [notificationResult, runningResult] = await Promise.all([
    notificationQuery.limit(50),
    db.from("automation_cycle_runs")
      .select("id")
      .eq("status", "running")
      .gte("started_at", new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())
      .limit(1),
  ]);
  if (notificationResult.error || runningResult.error) {
    throw new Error("The owner communication status could not be loaded.");
  }
  const notifications = notificationResult.data ?? [];
  const hasBadge = isRush
    ? notifications.some((item) => item.severity === "urgent")
    : notifications.length > 0;
  return { hasBadge, cycleRunning: (runningResult.data?.length ?? 0) > 0, isRush };
}

export async function queueOwnerDigest(now = new Date()): Promise<{
  status: "not_due" | "no_owner_email" | "no_pending_decisions" | "queued" | "already_queued";
  slot?: "pre_open" | "wrap_up";
}> {
  const settings = await getOwnerSettings();
  const slot = digestSlot(now, settings.openTime, settings.closeTime);
  if (!slot) return { status: "not_due" };
  if (!settings.ownerEmail) return { status: "no_owner_email", slot };
  if (!isEmail(settings.ownerEmail)) throw new Error("The owner email address in café settings is invalid.");

  const { data: approvals, error } = await inventoryClient().from("approval_inbox")
    .select("id,summary")
    .eq("status", "pending_approval")
    .order("created_at")
    .limit(3);
  if (error) throw new Error(`Could not load owner digest decisions: ${error.message}`);
  if (!approvals?.length) return { status: "no_pending_decisions", slot };

  const origin = digestAppUrl();
  const tokens: Array<{ approvalId: string; action: "approve" | "edit"; tokenHash: string }> = [];
  const items = approvals.map((value) => {
    const approval = row(value, "Digest approval");
    const approvalId = text(approval.id, "Digest approval ID");
    const summary = text(approval.summary, "Digest approval summary");
    const links: Record<"approve" | "edit", string> = { approve: "", edit: "" };
    for (const action of ["approve", "edit"] as const) {
      const token = createOwnerApprovalToken(approvalId, action, ownerTokenSecret());
      tokens.push({
        approvalId,
        action,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      });
      links[action] = new URL(`/owner/approval/${token}`, origin).toString();
    }
    return { summary, approveUrl: links.approve, editUrl: links.edit };
  });
  const eventId = randomUUID();
  const facts = {
    kind: "digest",
    date: sydneyDate(now),
    slot,
    ownerName: settings.ownerName,
    ownerEmail: settings.ownerEmail,
    items,
  };
  const { data, error: queueError } = await inventoryClient().rpc("queue_owner_digest", {
    p_digest_date: facts.date,
    p_slot: slot,
    p_event_id: eventId,
    p_facts: facts,
    p_tokens: tokens,
  });
  if (queueError || !data) {
    throw new Error(`Could not queue the owner digest: ${queueError?.message ?? "No queue result returned"}`);
  }
  const queueResult = row(data, "Owner digest queue result");
  const status = text(queueResult.status, "Owner digest status");
  if (status !== "queued" && status !== "already_queued") {
    throw new Error(`The owner digest returned an unknown status: ${status}`);
  }
  return { status, slot };
}

export async function getOwnerApprovalLink(token: string): Promise<{
  action: "approve" | "edit";
  approvalId: string;
  summary: string;
  details: Record<string, unknown>;
  expiresAt: string;
} | null> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(token)) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await inventoryClient().rpc("get_owner_approval_link", {
    p_token_hash: tokenHash,
  });
  if (error) throw new Error(`Could not verify the owner link: ${error.message}`);
  if (!data) return null;
  const value = row(data, "Owner approval link");
  const action = text(value.action, "Owner link action");
  const details = row(value.details, "Approval details");
  if (action !== "approve" && action !== "edit") throw new Error("The owner link action is invalid.");
  const approvalId = text(value.approval_id, "Approval ID");
  if (!verifyOwnerApprovalToken(token, approvalId, action, ownerTokenSecret())) return null;
  return {
    action,
    approvalId,
    summary: text(value.summary, "Approval summary"),
    details,
    expiresAt: text(value.expires_at, "Owner link expiry"),
  };
}

export async function consumeOwnerApprovalLink(input: {
  token: string;
  action: "approve" | "edit";
  summary?: string;
  details?: Record<string, unknown>;
}): Promise<"updated" | "invalid" | "used" | "stale"> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(input.token)) return "invalid";
  const link = await getOwnerApprovalLink(input.token);
  if (!link || link.action !== input.action) return "invalid";
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const { data, error } = await inventoryClient().rpc("consume_owner_approval_token", {
    p_token_hash: tokenHash,
    p_action: input.action,
    p_decision: input.action === "approve" ? "approved" : null,
    p_summary: input.summary ?? null,
    p_details: input.details ?? null,
  });
  if (error || !data) throw new Error(`Could not process the owner approval link: ${error?.message ?? "No result returned"}`);
  const result = row(data, "Owner approval result");
  const status = text(result.status, "Owner approval status");
  if (status !== "updated") {
    if (status === "invalid" || status === "used" || status === "stale") return status;
    throw new Error(`The owner approval link returned an unknown status: ${status}`);
  }
  if (input.action === "approve") {
    await finishOrderingApproval(text(result.approval_id, "Approval ID"), "approved");
  }
  return "updated";
}
