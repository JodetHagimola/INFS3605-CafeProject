import { streamText, isStepCount, type ModelMessage } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import { agentMessageSchema, inventoryCardItemSchema, type AgentMessagePart } from "@/lib/agent/chat-schema";
import { approvalItemSchema } from "@/lib/agent/approval-schema";
import { draftOrderSchema } from "@/lib/agent/draft-schema";
import { cafeLocalDate, readPublicHoliday } from "@/lib/agent/daily-brief";
import { getGeminiModel, geminiModelRejectionMessage } from "@/lib/agent/model";
import { AGENT_SYSTEM_PROMPT } from "@/lib/agent/runtime";
import { createAgentTools } from "@/lib/agent/tools";
import { inventoryClient } from "@/lib/inventory/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("new") }).strict(),
  z.object({
    operation: z.literal("message"),
    threadId: z.string().uuid(),
    text: z.string().trim().min(1).max(1000),
    route: z.string().trim().startsWith("/").max(200),
    visibleItemId: z.string().trim().max(120).optional(),
  }).strict(),
]);

type ThreadRow = { id: string; title: string };

async function createThread(): Promise<ThreadRow> {
  const { data, error } = await inventoryClient()
    .from("agent_threads")
    .insert({ title: "New conversation" })
    .select("id,title")
    .single();
  if (error || !data) {
    console.error("Could not create an agent conversation:", error?.message ?? "No row returned");
    throw new Error("Conversation storage is unavailable. Check the agent chat setup.");
  }
  return { id: String(data.id), title: String(data.title) };
}

async function loadLatestConversation() {
  const { data, error } = await inventoryClient()
    .from("agent_threads")
    .select("id,title")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("Could not read agent conversations:", error.message);
    throw new Error("Conversation storage is unavailable. Check the agent chat setup.");
  }
  const thread = data
    ? { id: String(data.id), title: String(data.title) }
    : await createThread();

  const { data: rows, error: messageError } = await inventoryClient()
    .from("agent_messages")
    .select("id,role,content,parts,created_at")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (messageError) {
    console.error("Could not read agent conversation messages:", messageError.message);
    throw new Error("Conversation messages could not be loaded.");
  }
  const messages = (rows ?? []).reverse().map((row) => agentMessageSchema.parse({
    id: String(row.id),
    role: row.role,
    content: row.content,
    parts: row.parts,
    createdAt: row.created_at,
  }));
  return { thread, messages };
}

export async function GET() {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to load chat." }, { status: 401 });
  }
  try {
    return NextResponse.json(await loadLatestConversation());
  } catch (error) {
    console.error("Could not load the latest conversation:", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({
      error: error instanceof Error && error.message.startsWith("Conversation")
        ? error.message
        : "Conversation history could not be loaded.",
    }, { status: 500 });
  }
}

async function saveMessage(input: {
  threadId: string;
  role: "owner" | "agent";
  content: string;
  parts: AgentMessagePart[];
}) {
  const { data, error } = await inventoryClient()
    .from("agent_messages")
    .insert({
      thread_id: input.threadId,
      role: input.role,
      content: input.content,
      parts: input.parts,
    })
    .select("id,role,content,parts,created_at")
    .single();
  if (error || !data) {
    console.error("Could not save an agent conversation message:", error?.message ?? "No row returned");
    throw new Error("Your message could not be saved.");
  }
  return agentMessageSchema.parse({
    id: String(data.id),
    role: data.role,
    content: data.content,
    parts: data.parts,
    createdAt: data.created_at,
  });
}

async function loadApprovalCards(ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await inventoryClient()
    .from("approval_inbox")
    .select("id,action,summary,details,status,created_at,reviewed_at,reviewer_note")
    .in("id", ids);
  if (error) {
    console.error("Could not load agent-created approval cards:", error.message);
    return [];
  }
  return (data ?? []).map((row) => approvalItemSchema.parse({
    id: String(row.id),
    action: row.action,
    summary: row.summary,
    details: row.details,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewerNote: row.reviewer_note,
  }));
}

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to use chat." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid chat request." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The chat request is invalid." }, { status: 400 });
  }

  try {
    if (parsed.data.operation === "new") {
      return NextResponse.json({ thread: await createThread(), messages: [] });
    }

    const { threadId, text, route, visibleItemId } = parsed.data;
    const { data: thread, error: threadError } = await inventoryClient()
      .from("agent_threads")
      .select("id,title")
      .eq("id", threadId)
      .maybeSingle();
    if (threadError || !thread) {
      console.error("Could not verify an agent conversation:", threadError?.message ?? "No row found");
      return NextResponse.json({ error: "This conversation could not be found." }, { status: 404 });
    }

    const { data: historyRows, error: historyError } = await inventoryClient()
      .from("agent_messages")
      .select("role,content")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(40);
    if (historyError) {
      console.error("Could not load chat context:", historyError.message);
      return NextResponse.json({ error: "Conversation context could not be loaded." }, { status: 500 });
    }

    const userMessage = await saveMessage({
      threadId,
      role: "owner",
      content: text,
      parts: [{ type: "text", text }],
    });
    const now = new Date().toISOString();
    const title = thread.title === "New conversation" ? text.slice(0, 60) : thread.title;
    const { error: updateError } = await inventoryClient()
      .from("agent_threads")
      .update({ title, updated_at: now })
      .eq("id", threadId);
    if (updateError) {
      console.error("Could not update agent conversation time:", updateError.message);
      return NextResponse.json({ error: "Your message was saved, but the conversation could not be updated." }, { status: 500 });
    }

    const today = cafeLocalDate();
    const holiday = await readPublicHoliday(today);
    const createdApprovalIds = new Set<string>();
    const agentTools = createAgentTools({
      forecastDate: today,
      isPublicHoliday: holiday.error ? null : holiday.name !== null,
    }, {
      onApprovalCreated: (approvalId) => createdApprovalIds.add(approvalId),
      saleRequestId: `${threadId}:${userMessage.id}`,
    });
    const messages: ModelMessage[] = [
      ...(historyRows ?? []).reverse().map((row) => ({
        role: row.role === "owner" ? "user" as const : "assistant" as const,
        content: String(row.content),
      })),
      { role: "user", content: text },
    ];

    let result;
    try {
      result = streamText({
        model: getGeminiModel(),
        instructions: [
          AGENT_SYSTEM_PROMPT,
          `Current page: ${route}.`,
          visibleItemId ? `Visible item ID: ${visibleItemId}.` : "No visible item ID was provided.",
          holiday.error
            ? "The public holiday calendar could not be checked. Do not assume holiday status."
            : holiday.name
              ? `The NSW calendar lists ${holiday.name} today.`
              : "The NSW calendar lists no public holiday today.",
        ].join("\n\n"),
        messages,
        tools: agentTools.tools,
        stopWhen: isStepCount(8),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(55_000),
      });
    } catch (error) {
      const message = geminiModelRejectionMessage(error)
        ?? (error instanceof Error && error.message === "The Gemini API key is not configured on the server."
          ? error.message
          : "The agent could not start this response. Please try again.");
      return NextResponse.json({ error: message, userMessage }, { status: 500 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        emit({ type: "user", message: userMessage });
        try {
          for await (const event of result.fullStream) {
            if (event.type === "text-delta") {
              emit({ type: "text", text: event.text });
            } else if (event.type === "tool-call") {
              emit({ type: "tool", name: event.toolName });
            }
          }

          const content = (await result.text).slice(0, 12_000) || "I finished the check. See the attached details.";
          const parts: AgentMessagePart[] = [{ type: "text", text: content }];
          const draft = agentTools.getDraft();
          if (draft) parts.push({ type: "draft_order", draft: draftOrderSchema.parse(draft) });

          const toolResults = await result.toolResults;
          const inventoryResult = toolResults.find((toolResult) => toolResult.toolName === "get_inventory");
          if (inventoryResult) {
            const parsedInventory = z.array(inventoryCardItemSchema).max(100).safeParse(inventoryResult.output);
            if (parsedInventory.success) {
              parts.push({ type: "stock_table", items: parsedInventory.data });
            }
          }

          const approvals = await loadApprovalCards([...createdApprovalIds]);
          for (const item of approvals) parts.push({ type: "approval_card", item });

          const message = await saveMessage({
            threadId,
            role: "agent",
            content,
            parts,
          });
          emit({ type: "complete", message });
        } catch (error) {
          const rejectedModel = geminiModelRejectionMessage(error);
          const message = rejectedModel
            ?? "The agent could not finish this response. Your message is saved; please try again.";
          console.error("The chat response failed:", error instanceof Error ? error.name : "Unknown error");
          emit({ type: "error", message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Could not prepare an agent chat response:", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({
      error: error instanceof Error && error.message.startsWith("Your message")
        ? error.message
        : "The agent chat could not be prepared. Check the chat setup.",
    }, { status: 500 });
  }
}
