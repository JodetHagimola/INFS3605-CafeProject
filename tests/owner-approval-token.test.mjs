import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOwnerApprovalToken,
  verifyOwnerApprovalToken,
} from '../lib/owner-approval-token.ts';

const secret = 'a-test-signing-secret-with-at-least-32-characters';
const approvalId = 'c236ca24-9f4f-4f11-9472-02ab1f439d77';

test('owner approval tokens verify only for their approval and action', () => {
  const token = createOwnerApprovalToken(approvalId, 'approve', secret);
  assert.match(token, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(verifyOwnerApprovalToken(token, approvalId, 'approve', secret), true);
  assert.equal(verifyOwnerApprovalToken(token, approvalId, 'edit', secret), false);
  assert.equal(verifyOwnerApprovalToken(token, 'another-approval', 'approve', secret), false);
});

test('owner approval token signatures reject tampering and weak signing keys', () => {
  const token = createOwnerApprovalToken(approvalId, 'edit', secret);
  const replacement = token.endsWith('A') ? 'B' : 'A';
  const tampered = `${token.slice(0, -1)}${replacement}`;
  assert.equal(verifyOwnerApprovalToken(tampered, approvalId, 'edit', secret), false);
  assert.throws(() => createOwnerApprovalToken(approvalId, 'edit', 'too-short'));
});
