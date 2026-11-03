import "server-only";

import { timingSafeEqual } from "node:crypto";

export function checkAgentPasscode(passcode: string): boolean {
  const expected = process.env.AGENT_PASSCODE;
  if (!expected) throw new Error("The agent passcode is not configured on the server.");
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(passcode);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}
