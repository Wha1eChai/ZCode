import assert from "node:assert/strict";
import test from "node:test";
import { resolveCapabilityBase, shouldClearStopRequested } from "./api.js";

test("resolveCapabilityBase keeps the Pi host token as the asset and API scope", () => {
  const token = "a".repeat(48);
  assert.equal(resolveCapabilityBase(`/${token}/`), `/${token}`);
  assert.equal(resolveCapabilityBase(`/${token}/state`), `/${token}`);
});

test("resolveCapabilityBase rejects paths without a safe first segment", () => {
  assert.equal(resolveCapabilityBase("/"), null);
  assert.equal(resolveCapabilityBase("/token.with.dot/"), null);
  assert.equal(resolveCapabilityBase("//"), null);
});

test("a queued stop stays pending while prompt admission is submitting", () => {
  assert.equal(shouldClearStopRequested({ phase: "submitting", streaming: false }), false);
  assert.equal(shouldClearStopRequested({ phase: "stopping", streaming: false }), false);
  assert.equal(shouldClearStopRequested({ phase: "running", streaming: true }), false);
  assert.equal(shouldClearStopRequested({ phase: "completedInterrupted", streaming: false }), true);
  assert.equal(shouldClearStopRequested({ phase: "idle", streaming: false }), true);
});
