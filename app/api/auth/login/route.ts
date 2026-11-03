import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AGENT_SESSION_COOKIE,
  agentSessionCookieOptions,
  checkAgentPasscode,
  createAgentSessionToken,
} from "@/lib/agent/auth";

export const runtime = "nodejs";

const requestSchema = z.object({
  passcode: z.string().min(1).max(128),
}).strict();

const ATTEMPT_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function checkRateLimit(key: string, now: number): number {
  let state = attempts.get(key);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + WINDOW_MS };
  }
  if (state.count >= ATTEMPT_LIMIT) {
    attempts.set(key, state);
    return Math.max(1, Math.ceil((state.resetAt - now) / 1000));
  }
  state.count += 1;
  attempts.set(key, state);
  return 0;
}

export async function POST(request: Request) {
  const key = clientKey(request);
  const retryAfter = checkRateLimit(key, Date.now());
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: "Too many login attempts. Please wait before trying again." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid login request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the shared passcode to continue." }, { status: 400 });
  }

  try {
    if (!checkAgentPasscode(parsed.data.passcode)) {
      return NextResponse.json({ error: "The passcode does not match." }, { status: 401 });
    }

    attempts.delete(key);
    const response = NextResponse.json({ status: "authenticated" });
    response.cookies.set(AGENT_SESSION_COOKIE, createAgentSessionToken(), agentSessionCookieOptions);
    return response;
  } catch {
    return NextResponse.json({ error: "Authentication is not configured on the server." }, { status: 500 });
  }
}
