import assert from "node:assert/strict";
import test from "node:test";
import { PiV4Projection } from "../host/projection.js";
import { parsePiViewState, resolveCapabilityBase, shouldClearStopRequested } from "./api.js";

const snapshot = new PiV4Projection("ephemeral-session", null).snapshot;

function makeViewState(toolMode?: unknown) {
  return {
    sessionId: "ephemeral-session",
    model: null,
    phase: "idle",
    streaming: false,
    snapshot,
    generation: 0,
    ...(toolMode === undefined ? {} : { toolMode }),
  };
}

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

test("parsePiViewState accepts and retains each exact tool mode", () => {
  for (const toolMode of ["read-only", "full"] as const) {
    assert.equal(parsePiViewState(makeViewState(toolMode))?.toolMode, toolMode);
  }
});

test("parsePiViewState rejects invalid or missing tool modes", () => {
  for (const toolMode of ["READ-ONLY", "full ", "none", null, 1]) {
    assert.equal(parsePiViewState(makeViewState(toolMode)), null);
  }
  assert.equal(parsePiViewState(makeViewState()), null);
});

test("a queued stop stays pending while prompt admission is submitting", () => {
  assert.equal(shouldClearStopRequested({ phase: "submitting", streaming: false }), false);
  assert.equal(shouldClearStopRequested({ phase: "stopping", streaming: false }), false);
  assert.equal(shouldClearStopRequested({ phase: "running", streaming: true }), false);
  assert.equal(shouldClearStopRequested({ phase: "completedInterrupted", streaming: false }), true);
  assert.equal(shouldClearStopRequested({ phase: "idle", streaming: false }), true);
});
