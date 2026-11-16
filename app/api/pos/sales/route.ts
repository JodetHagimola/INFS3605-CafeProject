import { NextResponse } from "next/server";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import { hashPosPayload, normalizePosItems, verifyPosSignature } from "@/lib/inventory-sales/pos";

export const runtime = "nodejs";

const requestSchema = z.object({
  external_ref: z.string().trim().min(1).max(116),
  occurred_at: z.string().refine((value) =>
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))),
  items: z.array(z.object({
    product_name: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(1000),
  }).strict()).min(1).max(100),
}).strict();

async function readLimitedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request) {
  const secret = process.env.POS_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "POS webhook is not configured." }, { status: 503 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let rawBody: Uint8Array | null;
  try {
    rawBody = await readLimitedBody(request, 64 * 1024);
  } catch {
    return NextResponse.json({ error: "The POS request body could not be read." }, { status: 400 });
  }
  if (!rawBody) {
    return NextResponse.json({ error: "The POS request exceeds the 64 KB limit." }, { status: 413 });
  }
  if (!verifyPosSignature(rawBody, request.headers.get("x-pos-signature"), secret)) {
    return NextResponse.json({ error: "The POS signature is invalid." }, { status: 401 });
  }
  if (!inventoryWritesEnabled()) {
    return NextResponse.json({ error: "Stock changes are disabled by server policy." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return NextResponse.json({ error: "Please submit valid JSON." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The POS sales payload is invalid." }, { status: 400 });
  }
  const items = normalizePosItems(parsed.data.items);
  if (!items) {
    return NextResponse.json({ error: "POS products must have valid names and quantities, with no total above 1,000 per drink." }, { status: 400 });
  }

  try {
    const { data, error } = await inventoryClient().rpc("record_pos_sales_event", {
      p_external_ref: parsed.data.external_ref,
      p_occurred_at: new Date(parsed.data.occurred_at).toISOString(),
      p_items: items,
      p_payload_hash: hashPosPayload(rawBody),
    });
    if (error) {
      const conflict = ["INSUFFICIENT_STOCK", "RECIPE_NOT_FOUND", "INVALID_RECIPE", "POS_EVENT_CONFLICT",
        "SALE_EXTERNAL_REF_CONFLICT", "NO_STOCK_RECORD"].some((code) => error.message.includes(code));
      console.error("POS sale event was not recorded:", error.message);
      return NextResponse.json(
        { error: conflict ? "The POS sale conflicts with current stock, recipe, or a previously received event." : "The POS sale could not be recorded." },
        { status: conflict ? 409 : 500 },
      );
    }
    if (!data || typeof data !== "object") {
      return NextResponse.json({ error: "The POS sale could not be confirmed." }, { status: 500 });
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("POS sale endpoint failed:", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({ error: "The POS sale could not be recorded." }, { status: 500 });
  }
}
