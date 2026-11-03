import { NextResponse } from "next/server";
import { AGENT_SESSION_COOKIE, agentSessionCookieOptions } from "@/lib/agent/auth";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ status: "logged_out" });
  response.cookies.set(AGENT_SESSION_COOKIE, "", {
    ...agentSessionCookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
