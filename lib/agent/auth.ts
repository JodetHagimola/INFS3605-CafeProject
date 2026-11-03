import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const AGENT_SESSION_COOKIE = "brewlytics_session";
export const AGENT_SESSION_MAX_AGE = 12 * 60 * 60;

export const agentSessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: AGENT_SESSION_MAX_AGE,
};

export function checkAgentPasscode(passcode: string): boolean {
  const expected = process.env.AGENT_PASSCODE;
  if (!expected) throw new Error("The agent passcode is not configured on the server.");
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(passcode);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

function sessionSecret(): string | null {
  return process.env.AGENT_PASSCODE || null;
}

export function createAgentSessionToken(): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("The agent passcode is not configured on the server.");

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + AGENT_SESSION_MAX_AGE;
  const payload = `${issuedAt}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidAgentSessionToken(token: string | undefined): boolean {
  const secret = sessionSecret();
  if (!secret || !token) return false;

  const [issuedAtText, expiresAtText, suppliedSignature, ...extra] = token.split(".");
  if (!issuedAtText || !expiresAtText || !suppliedSignature || extra.length > 0) return false;

  const issuedAt = Number(issuedAtText);
  const expiresAt = Number(expiresAtText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || issuedAt > now + 60 || expiresAt <= now
    || expiresAt <= issuedAt || expiresAt - issuedAt > AGENT_SESSION_MAX_AGE) {
    return false;
  }

  const payload = `${issuedAtText}.${expiresAtText}`;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  const actualSignature = Buffer.from(suppliedSignature, "base64url");
  return actualSignature.length === expectedSignature.length
    && timingSafeEqual(expectedSignature, actualSignature);
}

export async function hasAgentSession(): Promise<boolean> {
  const cookieStore = await cookies();
  return isValidAgentSessionToken(cookieStore.get(AGENT_SESSION_COOKIE)?.value);
}
