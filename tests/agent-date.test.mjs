import assert from "node:assert/strict";
import test from "node:test";
import { isValidISODate } from "../lib/agent/date.ts";

test("brief date validation accepts real ISO calendar dates", () => {
  assert.equal(isValidISODate("2024-02-29"), true);
  assert.equal(isValidISODate("2026-11-05"), true);
});

test("brief date validation rejects invalid dates without throwing", () => {
  for (const value of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-05", "not-a-date"]) {
    assert.equal(isValidISODate(value), false, value);
  }
});
