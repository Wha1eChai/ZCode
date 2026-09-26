// Replay the probe's V4 frames into ZCode's real SessionDataLayer/ConversationProjectionStore.
// Invoked by pi-v4-smoke.mjs after each model turn.
export async function checkZCodeStore(SessionDataLayer, schema, initial, frames) {
  const topic = `conversation/${initial.sessionId}`;
  const subscriptionId = `pi-probe-${initial.sessionId}`;
  const frameListeners = new Set();
  const transport = {
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    onAssemblyFault() { return () => {}; },
    onRuntimeRestart() { return () => {}; },
    async subscribe({ topic: requestedTopic }) {
      if (requestedTopic !== topic) throw new Error(`Unexpected topic: ${requestedTopic}`);
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: initial.logEpoch } };
    },
    activate(id) {
      if (id !== subscriptionId) throw new Error(`Unexpected subscription: ${id}`);
      const snapshot = schema.conversationTopicFrameSchema.parse({
        topic, subscriptionId, fromSeq: 0, toSeq: 0, sentAt: Date.now(),
        payload: { kind: "snapshot", snapshot: initial },
      });
      for (const listener of frameListeners) listener(snapshot, { deliveryKind: "initial" });
      for (const frame of frames) {
        for (const listener of frameListeners) listener(frame, { deliveryKind: "online" });
      }
    },
    async unsubscribe() {},
  };
  const layer = new SessionDataLayer({ transport, keepWarmMs: 0 });
  const lease = layer.acquire(initial.sessionId);
  try {
    for (let attempt = 0; attempt < 20 && lease.store.getState().snapshot === null; attempt++) {
      await new Promise((ok) => setTimeout(ok, 10));
    }
    const state = lease.store.getState();
    if (state.status !== "live" || !state.snapshot) {
      throw new Error(`ZCode store not live: ${state.status}; ${state.lastError ?? ""}`);
    }
    return { seq: state.snapshot.seq, rows: state.snapshot.rows.window.length, snapshot: state.snapshot };
  } finally {
    lease.release();
    layer.dispose();
  }
}
