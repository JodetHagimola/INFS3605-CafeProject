import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OwnerApprovalAction = "approve" | "edit";

function signature(
  nonce: string,
  approvalId: string,
  action: OwnerApprovalAction,
  secret: string,
): Buffer {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("The owner approval link signing key must be at least 32 characters.");
  }
  return createHmac("sha256", secret).update(`${nonce}.${approvalId}.${action}`).digest();
}

export function createOwnerApprovalToken(
  approvalId: string,
  action: OwnerApprovalAction,
  secret: string,
): string {
  const nonce = randomBytes(32).toString("base64url");
  return `${nonce}${signature(nonce, approvalId, action, secret).toString("base64url")}`;
}

export function verifyOwnerApprovalToken(
  token: string,
  approvalId: string,
  action: OwnerApprovalAction,
  secret: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(token)) return false;
  const nonce = token.slice(0, 43);
  const supplied = Buffer.from(token.slice(43), "base64url");
  const expected = signature(nonce, approvalId, action, secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
