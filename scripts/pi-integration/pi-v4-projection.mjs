// Experimental, single-session Pi RPC -> ZCode V4 conversation projection.
// Not a production transport: no persistence, history paging, permissions, or reconnection.
export function createPiV4Projection(schema, sessionId, model = {}) {
  const { conversationSnapshotSchema, conversationTopicFrameSchema, applyConversationDeltas } = schema;
  const topic = `conversation/${sessionId}`;
  const subscriptionId = `pi-probe-${sessionId}`;
  const unavailable = { allowed: false, reasonCode: "pi.probe.unsupported" };
  const snapshot = conversationSnapshotSchema.parse({
    protocolVersion: 1, sessionId, logEpoch: `pi-probe-${sessionId}`, seq: 0, revision: 0,
    control: {
      phase: "draft", sessionEnded: false, canStop: false, stopState: "idle",
      stopTargetKind: "unknown", activeWorks: [], lastError: null, apiRetry: null,
    },
    availability: {
      fork: unavailable, compact: unavailable, switchModelConfig: unavailable,
      setFollowupMode: unavailable, queueEdit: unavailable, sendQueuedNow: unavailable,
      pauseGoal: unavailable, resumeGoal: unavailable,
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Pi RPC probe", titleSource: "default" },
    config: {
      provider: model.provider ?? "", model: model.id ?? "", thought: "off",
      thoughtLevels: [], followupMode: "queue", mode: "build",
    },
    modelTransition: null,
    usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    queue: { items: [], autoDrain: false }, pendingInteractions: [], pendingCommands: [],
    backgroundWorks: [], subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null, plan: null, workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
  let state = snapshot;
  const frames = [];
  let nextRowId = 1;
  let turnId = `pi-turn-${sessionId}`;
  let textRowId = null;
  let startedAt = 0;
  let stopped = false;
  const toolRows = new Map();
  let userRowCount = 0;

  function emit(delta) {
    const fromSeq = state.seq;
    const frame = conversationTopicFrameSchema.parse({
      topic, subscriptionId, fromSeq, toSeq: fromSeq + 1, sentAt: Date.now(),
      payload: { kind: "deltas", deltas: [delta] },
    });
    state = conversationSnapshotSchema.parse({
      ...applyConversationDeltas(state, frame.payload.deltas), seq: frame.toSeq,
    });
    frames.push(frame);
  }
  function row(kind, extra = {}) {
    const rowId = nextRowId++;
    return {
      rowId, turnId, entityId: `pi-entity-${sessionId}-${rowId}`,
      productTurnId: turnId, createdAt: Date.now(), createdAtSeq: state.seq + 1,
      kind, ...extra,
    };
  }
  function append(kind, extra) {
    const entry = row(kind, extra);
    emit({ op: "row.appended", row: entry });
    return entry;
  }
  function update(rowId, patch) {
    const previous = state.rows.window.find((entry) => entry.rowId === rowId);
    if (previous) emit({ op: "row.upserted", row: { ...previous, ...patch } });
  }
  function control(phase, canStop) {
    emit({ op: "state.updated", patch: {
      control: {
        phase, sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
        canStop, stopState: canStop ? "stoppable" : "idle", stopTargetKind: canStop ? "assistant" : "unknown",
        activeWorks: canStop ? [{ kind: "primaryTurn", startedAt }] : [], lastError: null, apiRetry: null,
      },
      inputRouting: { mode: canStop ? "reject" : "startNow", ...(canStop ? { reasonCode: "pi.probe.busy" } : {}) },
    } });
  }
  function getOrCreateTextRow() {
    if (textRowId === null) textRowId = append("assistantText", { text: "", state: "streaming" }).rowId;
    return textRowId;
  }
  function observe(event) {
    switch (event.type) {
      case "agent_start": {
        startedAt = Date.now();
        turnId = `pi-turn-${sessionId}-${startedAt}`;
        textRowId = null;
        stopped = false;
        append("turnHeader", { origin: "userInput", executionKind: "agent", state: "running", startedAt });
        control("running", true);
        break;
      }
      case "message_start":
        if (event.message?.role === "user") {
          const content = event.message.content;
          const text = typeof content === "string" ? content : Array.isArray(content)
            ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
          append("userInput", { text, origin: "realUser" });
          userRowCount++;
        }
        break;
      case "message_update": {
        const part = event.assistantMessageEvent;
        if (part?.type === "text_delta" && part.delta) {
          emit({ op: "row.delta", rowId: getOrCreateTextRow(), path: "text", append: part.delta });
        }
        if (part?.type === "text_end") update(getOrCreateTextRow(), { text: part.content });
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant") {
          if (event.message.stopReason === "aborted") stopped = true;
          const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
          if (text || textRowId !== null) {
            update(getOrCreateTextRow(), {
              text, state: event.message.stopReason === "aborted" ? "interrupted"
                : event.message.stopReason === "error" ? "failed" : "complete",
            });
            textRowId = null;
          }
        }
        break;
      case "tool_execution_start": {
        const entry = append("toolCall", {
          toolCallId: event.toolCallId, toolName: event.toolName, status: "running",
          inputText: JSON.stringify(event.args ?? {}), input: event.args, startedAt: Date.now(),
        });
        toolRows.set(event.toolCallId, entry.rowId);
        break;
      }
      case "tool_execution_end": {
        const rowId = toolRows.get(event.toolCallId);
        if (rowId !== undefined) {
          const output = event.result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
          update(rowId, {
            status: event.isError ? "error" : "success", output: { text: output.slice(0, 32_000) },
            ...(event.isError ? { error: { code: "pi.tool_error", message: output.slice(0, 500) || "Tool failed" } } : {}),
            endedAt: Date.now(),
          });
          toolRows.delete(event.toolCallId);
        }
        break;
      }
      case "agent_end":
        // agent_end is not necessarily terminal: Pi may retry before agent_settled.
        break;
      case "agent_settled": {
        const header = [...state.rows.window].reverse().find((entry) => entry.kind === "turnHeader" && entry.turnId === turnId);
        if (header) update(header.rowId, { state: stopped ? "completedInterrupted" : "completedSuccess", endedAt: Date.now() });
        control(stopped ? "completedInterrupted" : "completedSuccess", false);
        break;
      }
    }
  }
  return {
    observe, initial: snapshot, get snapshot() { return state; }, get frames() { return frames; },
    get userRowCount() { return userRowCount; },
    checkReplay() {
      let replay = snapshot;
      for (const frame of frames) {
        if (replay.seq !== frame.fromSeq) throw new Error(`Gap at ${frame.fromSeq}`);
        replay = { ...applyConversationDeltas(replay, frame.payload.deltas), seq: frame.toSeq };
      }
      if (JSON.stringify(replay) !== JSON.stringify(state)) throw new Error("Delta replay differs from final snapshot");
      return { frames: frames.length, seq: state.seq, rows: state.rows.window.length };
    },
  };
}
