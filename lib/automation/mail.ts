import "server-only";
import { inventoryClient } from "@/lib/inventory/server";
import { tailorSupplierDraft } from "@/lib/inventory-deliveries/followups";
import { supplierDraft, type ShortageRow } from "@/lib/inventory-deliveries/shortage-email";
import { factText, formatOrderLine, isEmail, isSupplierAddress, testMailRecipient } from "./mail-model";

type Payload = { from: string; to: string; subject: string; text: string; reply_to?: string };
type Job = { event_id: string; status: string; channel: "inbox" | "resend" | null; payload: Payload | null; started_at: string | null;
  facts: Record<string, unknown> };

async function assertNotSupplierAddress(to: string): Promise<void> {
  const { data, error } = await inventoryClient().from("suppliers").select("contact_email");
  if (error) throw new Error("Could not verify the test mailbox against supplier contacts.");
  if (isSupplierAddress(to, (data ?? []).map((supplier) => supplier.contact_email))) {
    throw new Error("The configured test mailbox matches a supplier contact.");
  }
}

async function compose(job: Job): Promise<{ subject: string; text: string; replyTo?: string }> {
  const f = job.facts;
  const kind = factText(f, "kind");
  if (kind === "digest") {
    if (!Array.isArray(f.items) || f.items.length < 1 || f.items.length > 3) {
      throw new Error("Owner digest facts must contain one to three decisions.");
    }
    const appUrl = process.env.APP_URL?.trim();
    if (!appUrl) throw new Error("The application URL is not configured for owner digest links.");
    const expectedOrigin = new URL(appUrl).origin;
    const lines = f.items.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("An owner digest item is invalid.");
      }
      const item = value as Record<string, unknown>;
      const summary = factText(item, "summary");
      const approveUrl = new URL(factText(item, "approveUrl"));
      const editUrl = new URL(factText(item, "editUrl"));
      const validPath = /^\/owner\/approval\/[A-Za-z0-9_-]{86}$/.test(approveUrl.pathname)
        && /^\/owner\/approval\/[A-Za-z0-9_-]{86}$/.test(editUrl.pathname);
      if (approveUrl.origin !== expectedOrigin || editUrl.origin !== expectedOrigin || !validPath) {
        throw new Error("Owner digest links do not match the configured application URL.");
      }
      return `${index + 1}. ${summary}\n   Approve: ${approveUrl.toString()}\n   Edit: ${editUrl.toString()}`;
    });
    const ownerEmail = typeof f.ownerEmail === "string" && f.ownerEmail.trim() ? f.ownerEmail.trim() : undefined;
    if (ownerEmail && !isEmail(ownerEmail)) throw new Error("The owner email address is invalid.");
    const ownerName = typeof f.ownerName === "string" && f.ownerName.trim() ? ` ${f.ownerName.trim()}` : "";
    return {
      subject: `Brewly ${factText(f, "slot").replaceAll("_", " ")} owner digest · ${factText(f, "date")}`,
      text: [
        `Hello${ownerName},`,
        "",
        "Here are the decisions that need your attention:",
        "",
        ...lines,
        "",
        "Opening a link does not make a decision. Confirming it on the review page does.",
        "This test-mode digest is routed to the configured test inbox.",
      ].join("\n"),
      replyTo: ownerEmail,
    };
  }
  if (kind === "order") {
    if (!Array.isArray(f.lines) || !f.lines.length) throw new Error("Order email facts have no lines.");
    const reference = factText(f, "reference");
    const supplier = factText(f, "supplier");
    const totalCents = Number(f.totalCents);
    if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error("Order email total is invalid.");
    const { data, error } = await inventoryClient()
      .from("cafe_settings")
      .select("owner_email")
      .eq("id", 1)
      .single();
    if (error || !data) throw new Error("Could not read the owner reply-to address.");
    const replyTo = typeof data.owner_email === "string" && data.owner_email.trim()
      ? data.owner_email.trim()
      : undefined;
    if (replyTo && !isEmail(replyTo)) throw new Error("The owner reply-to address is invalid.");
    return {
      subject: `Test order ${reference} for ${supplier}`,
      text: [
        `Hello ${supplier} team,`,
        "",
        `This is a test-mode order email for reference ${reference}.`,
        "",
        ...(f.lines as unknown[]).map(formatOrderLine),
        "",
        `Estimated total: $${(totalCents / 100).toFixed(2)}.`,
        "",
        "This message is routed to the configured test inbox. It is not a live supplier order.",
        "",
        "Thank you.",
      ].join("\n"),
      replyTo,
    };
  }
  if (kind === "short") {
    const receipt = factText(f, "receipt");
    try { await tailorSupplierDraft(receipt); } catch { /* The saved standard wording is ready to use. */ }
    const { data,error } = await inventoryClient().from("delivery_shortage_drafts").select("receipt_id,approach,facts")
      .eq("receipt_id",receipt).single<ShortageRow>();
    if (error || !data) throw new Error("Could not read saved shortage.");
    const draft = supplierDraft({...data,facts:{...data.facts,reference:factText(f, "reference")}});
    return {subject:draft.subject,text:draft.body};
  }
  if (kind === "extra") {
    const reference = factText(f, "reference");
    const ordered = factText(f, "ordered");
    const received = factText(f, "received");
    const difference = factText(f, "difference");
    const unit = factText(f, "unit");
    const ingredient = factText(f, "ingredient");
    return {subject:`Extra goods received for ${reference}`,text:
      `Hello,\n\nWe ordered ${ordered} ${unit} of ${ingredient} and received ${received} ${unit} in total. Please check the extra ${difference} ${unit} against your dispatch record and advise.\n\nThank you.`};
  }
  if (kind === "chase") {
    const reference = factText(f, "reference");
    const supplier = typeof f.supplier === "string" && f.supplier.trim() ? `${f.supplier.trim()} team` : "there";
    const expectedDate = factText(f, "expectedDate");
    const ordered = factText(f, "ordered");
    const received = factText(f, "received");
    const missing = factText(f, "missing");
    const unit = factText(f, "unit");
    const ingredient = factText(f, "ingredient");
    return {
      subject: `Overdue delivery follow-up for ${reference}`,
      text: `Hello ${supplier},\n\nWe are following up on ${reference}, expected on ${expectedDate}. We ordered ${ordered} ${unit} of ${ingredient} and have received ${received} ${unit}; ${missing} ${unit} remains outstanding.\n\nCould you confirm the delivery status and expected arrival time?\n\nThank you.`,
    };
  }
  throw new Error("The mail queue contains an unsupported message type.");
}

export async function deliverTestMail(eventId: string) {
  const db = inventoryClient();
  const jobs = () => db.from("cafe_test_mail");
  const loaded = await jobs().select("*").eq("event_id",eventId).single<Job>();
  if (loaded.error || !loaded.data) throw new Error("Email queue unavailable.");
  let job = loaded.data;
  if (job.status !== "queued") return job.status;
  try {
    if (!job.payload) {
      const channel = process.env.CAFE_MAIL_MODE || "inbox";
      if (channel !== "inbox" && channel !== "resend") throw new Error("Invalid test mail mode.");
      const configuredTo = process.env.CAFE_TEST_MAIL_TO?.trim();
      const to = testMailRecipient(channel, configuredTo);
      const from = process.env.CAFE_TEST_MAIL_FROM?.trim() || (channel === "inbox" ? "cafe@test.invalid" : undefined);
      if (!from || !isEmail(from)) throw new Error("Set a valid test sender address.");
      if (configuredTo) await assertNotSupplierAddress(to);
      const content = await compose(job);
      const {data,error} = await db.rpc("prepare_cafe_test_mail",{
        p_event:eventId,
        p_channel:channel,
        p_payload:{from,to,subject:content.subject,text:content.text,...(content.replyTo ? {reply_to:content.replyTo} : {})},
      });
      if (error || !data) throw new Error("Cannot save email for delivery.");
      job = data as Job;
      if (job.status !== "queued") return job.status;
    }
    let providerId = eventId;
    if (job.channel === "resend") {
      if (process.env.CAFE_TEST_MAIL_SEND_ENABLED !== "true") {
        throw new Error("External test-mail delivery is disabled.");
      }
      // Never reuse a possibly accepted key beyond the provider's 24-hour window.
      if (!job.started_at || Date.now()-Date.parse(job.started_at)>23*3600_000) {
        const {error} = await jobs().update({status:"check_delivery",last_error:"Check provider history before resending."}).eq("event_id",eventId).eq("status","queued");
        if (error) throw new Error("Cannot save mail status.");
        return "check_delivery";
      }
      if (process.env.CAFE_MAIL_MODE !== "resend" || !process.env.RESEND_API_KEY
        || !process.env.CAFE_TEST_MAIL_TO?.trim()
        || job.payload?.to !== process.env.CAFE_TEST_MAIL_TO.trim()) {
        throw new Error("Check test mail configuration.");
      }
      await assertNotSupplierAddress(job.payload.to);
      const response = await fetch("https://api.resend.com/emails",{method:"POST",cache:"no-store",
        headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`brewly-test/${eventId}`},
        body:JSON.stringify(job.payload),signal:AbortSignal.timeout(7000)});
      if (!response.ok) throw new Error("Email provider declined the request.");
      const result = await response.json();
      if (typeof result.id !== "string" || !result.id) throw new Error("Email provider response was incomplete.");
      providerId=result.id;
    }
    const status=job.channel==="resend" ? "provider_accepted" : "delivered_to_demo";
    const {error} = await jobs().update({status,provider_id:providerId,sent_at:new Date().toISOString(),last_error:null}).eq("event_id",eventId).eq("status","queued");
    if (error) throw new Error("Cannot save mail status.");
    return status;
  } catch {
    console.error("Test mail delivery failed:", eventId);
    const { error } = await jobs().update({last_error:"Delivery pending. Check the test mail configuration or retry later.",retry_at:new Date(Date.now()+60000).toISOString()})
      .eq("event_id",eventId).eq("status","queued");
    if (error) throw new Error("Could not save the test mail retry state.");
    return "queued";
  }
}

export async function processPendingMail() {
  const {data,error}=await inventoryClient().from("cafe_test_mail").select("event_id").eq("status","queued")
    .lte("retry_at",new Date().toISOString()).order("retry_at").limit(4);
  if(error) throw new Error("Email queue unavailable.");
  return Promise.all((data??[]).map(row=>deliverTestMail(String(row.event_id))));
}
