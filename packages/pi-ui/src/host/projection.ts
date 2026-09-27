import {
  applyConversationDelta,
  conversationDeltaSchema,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationDelta,
  type ConversationSnapshot,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";

const MAX_ROWS = 60;
const MAX_SNAPSHOT_BYTES = 768 * 1024;
const MAX_TEXT_CHARS = 64_000;
const MAX_TOOL_INPUT_CHARS = 16_000;
const MAX_TOOL_OUTPUT_CHARS = 32_000;
const MAX_TRACKED_TOOLS = 256;

export type ProjectionPhase = "running" | "completedSuccess" | "completedInterrupted" | "error";

type PiRecord = Record<string, any>;
type ChangeListener = (snapshot: ConversationSnapshot) => void;

function boundedText(value: unknown, limit = MAX_TEXT_CHARS): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return boundedText(content);
  if (!Array.isArray(content)) return "";
  return boundedText(
    content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join(""),
  );
}

function stringifyBounded(value: unknown, limit: number): string {
  try {
    return (JSON.stringify(value ?? {}) ?? "{}").slice(0, limit);
  } catch {
    return "{}";
  }
}

export class PiV4Projection {
  private current: ConversationSnapshot;
  private nextRowId = 1;
  private turnNumber = 0;
  private turnId = "";
  private turnHeaderId: number | null = null;
  private textRowId: number | null = null;
  private activeAssistantText = "";
  private runOutcome: "success" | "aborted" | "error" = "success";
  private settled = true;
  private readonly toolRows = new Map<string, number>();
  private readonly finishedTools = new Set<string>();
  private listener?: ChangeListener;

  constructor(
    readonly sessionId: string,
    model: { provider?: string; id?: string } | null | undefined,
    listener?: ChangeListener,
  ) {
    this.listener = listener;
    this.current = conversationSnapshotSchema.parse({
      protocolVersion: 1,
      sessionId,
      logEpoch: `pi-${sessionId}`,
      seq: 0,
      revision: 0,
      control: {
        phase: "draft",
        sessionEnded: false,
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
        lastError: null,
        apiRetry: null,
      },
      availability: {
        fork: { allowed: false, reasonCode: "pi.unsupported" },
        compact: { allowed: false, reasonCode: "pi.unsupported" },
        switchModelConfig: { allowed: false, reasonCode: "pi.unsupported" },
        setFollowupMode: { allowed: false, reasonCode: "pi.unsupported" },
        queueEdit: { allowed: false, reasonCode: "pi.unsupported" },
        sendQueuedNow: { allowed: false, reasonCode: "pi.unsupported" },
        pauseGoal: { allowed: false, reasonCode: "pi.unsupported" },
        resumeGoal: { allowed: false, reasonCode: "pi.unsupported" },
      },
      inputRouting: { mode: "startNow" },
      meta: { title: "Pi session", titleSource: "default" },
      config: {
        provider: model?.provider ?? "",
        model: model?.id ?? "",
        thought: "off",
        thoughtLevels: [],
        followupMode: "queue",
        mode: "build",
      },
      modelTransition: null,
      usage: {
        contextWindow: null,
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      queue: { items: [], autoDrain: false },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
      goal: null,
      plan: null,
      workspaceHookAdmission: null,
      rows: { window: [], totalCount: 0, firstRowId: null },
    });
  }

  get snapshot(): ConversationSnapshot {
    return this.current;
  }

  setListener(listener: ChangeListener): void {
    this.listener = listener;
  }

  private apply(deltaInput: ConversationDelta): void {
    const delta = conversationDeltaSchema.parse(deltaInput);
    const fromSeq = this.current.seq;
    const frame = conversationTopicFrameSchema.parse({
      topic: `conversation/${this.sessionId}`,
      subscriptionId: `pi-${this.sessionId}`,
      fromSeq,
      toSeq: fromSeq + 1,
      sentAt: Date.now(),
      payload: { kind: "deltas", deltas: [delta] },
    });
    if (frame.payload.kind !== "deltas")
      throw new Error("Pi projection frame did not contain deltas.");
    const framedDelta = frame.payload.deltas[0];
    if (!framedDelta) throw new Error("Pi projection delta was empty.");
    const applied = applyConversationDelta(this.current, framedDelta);
    const window = applied.rows.window.slice(-MAX_ROWS);
    const boundedSnapshot = () =>
      conversationSnapshotSchema.parse({
        ...applied,
        revision: frame.toSeq,
        seq: frame.toSeq,
        rows: {
          window,
          // Pi is an ephemeral transcript. The visible bounded window is the complete available view.
          totalCount: window.length,
          firstRowId: window[0]?.rowId ?? null,
        },
      });
    let nextSnapshot = boundedSnapshot();
    while (
      window.length > 1 &&
      Buffer.byteLength(JSON.stringify(nextSnapshot), "utf8") > MAX_SNAPSHOT_BYTES
    ) {
      window.shift();
      nextSnapshot = boundedSnapshot();
    }
    if (Buffer.byteLength(JSON.stringify(nextSnapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("Pi conversation projection exceeded its snapshot byte limit.");
    }
    this.current = nextSnapshot;
    this.listener?.(this.current);
  }

  private makeRow(kind: string, extra: Record<string, unknown> = {}): ConversationRow {
    const rowId = this.nextRowId++;
    const row = {
      rowId,
      turnId: this.turnId || `pi-turn-${this.sessionId}-0`,
      entityId: `pi-${this.sessionId}-${rowId}`,
      productTurnId: this.turnId || `pi-turn-${this.sessionId}-0`,
      createdAt: Date.now(),
      createdAtSeq: this.current.seq + 1,
      kind,
      ...extra,
    };
    return row as ConversationRow;
  }

  private append(kind: string, extra: Record<string, unknown> = {}): ConversationRow {
    const row = this.makeRow(kind, extra);
    this.apply({ op: "row.appended", row });
    return row;
  }

  private upsert(rowId: number, patch: Record<string, unknown>): void {
    const previous = this.current.rows.window.find((row) => row.rowId === rowId);
    if (!previous) return;
    this.apply({ op: "row.upserted", row: { ...previous, ...patch } as ConversationRow });
  }

  setRunState(phase: ProjectionPhase | "draft", canStop: boolean, stopping = false): void {
    const startedAt = Date.now();
    this.apply({
      op: "state.updated",
      patch: {
        control: {
          phase,
          sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
          canStop,
          stopState: stopping ? "stopping" : canStop ? "stoppable" : "idle",
          stopTargetKind: canStop ? "assistant" : "unknown",
          activeWorks: canStop ? [{ kind: "primaryTurn", startedAt }] : [],
          lastError: null,
          apiRetry: null,
        },
        inputRouting: canStop
          ? { mode: "reject", reasonCode: "pi.session.busy" }
          : { mode: "startNow" },
      },
    });
  }

  observe(event: PiRecord): { terminal?: "idle" | "aborted" | "error" } {
    switch (event.type) {
      case "agent_start": {
        if (!this.settled) return {};
        this.turnNumber += 1;
        this.turnId = `pi-turn-${this.sessionId}-${this.turnNumber}`;
        this.turnHeaderId = null;
        this.textRowId = null;
        this.activeAssistantText = "";
        this.runOutcome = "success";
        this.settled = false;
        this.toolRows.clear();
        this.finishedTools.clear();
        const startedAt = Date.now();
        const header = this.append("turnHeader", {
          origin: "userInput",
          executionKind: "agent",
          state: "running",
          startedAt,
        });
        this.turnHeaderId = header.rowId;
        this.setRunState("running", true);
        break;
      }
      case "message_start": {
        if (this.settled || event.message?.role !== "user") break;
        this.append("userInput", {
          text: messageText(event.message.content),
          origin: "realUser",
        });
        break;
      }
      case "message_update": {
        if (this.settled) break;
        const messageEvent = event.assistantMessageEvent;
        if (messageEvent?.type === "text_delta" && typeof messageEvent.delta === "string") {
          const remaining = MAX_TEXT_CHARS - this.activeAssistantText.length;
          const delta = messageEvent.delta.slice(0, Math.max(remaining, 0));
          if (!delta) break;
          this.activeAssistantText += delta;
          if (this.textRowId === null) {
            this.textRowId = this.append("assistantText", { text: "", state: "streaming" }).rowId;
          }
          this.apply({ op: "row.delta", rowId: this.textRowId, path: "text", append: delta });
        } else if (messageEvent?.type === "text_end") {
          const final = boundedText(messageEvent.content);
          this.activeAssistantText = final;
          if (this.textRowId === null && final) {
            this.textRowId = this.append("assistantText", {
              text: final,
              state: "streaming",
            }).rowId;
          } else if (this.textRowId !== null) {
            this.upsert(this.textRowId, { text: final, state: "streaming" });
          }
        }
        break;
      }
      case "message_end": {
        if (this.settled || event.message?.role !== "assistant") break;
        const final = messageText(event.message.content);
        const stopReason = event.message.stopReason;
        if (stopReason === "aborted") this.runOutcome = "aborted";
        if (stopReason === "error") this.runOutcome = "error";
        if (this.textRowId !== null) {
          this.upsert(this.textRowId, {
            text: final,
            state:
              stopReason === "aborted"
                ? "interrupted"
                : stopReason === "error"
                  ? "failed"
                  : "complete",
          });
        } else if (final) {
          const row = this.append("assistantText", {
            text: final,
            state:
              stopReason === "aborted"
                ? "interrupted"
                : stopReason === "error"
                  ? "failed"
                  : "complete",
          });
          this.textRowId = row.rowId;
        }
        this.textRowId = null;
        this.activeAssistantText = "";
        break;
      }
      case "tool_execution_start": {
        if (this.settled) break;
        const id = boundedText(event.toolCallId, 256);
        if (!id || this.toolRows.has(id) || this.finishedTools.has(id)) break;
        const input = event.args ?? {};
        const serializedInput = stringifyBounded(input, MAX_TOOL_INPUT_CHARS + 1);
        const argsText = serializedInput.slice(0, MAX_TOOL_INPUT_CHARS);
        const row = this.append("toolCall", {
          toolCallId: id,
          toolName: boundedText(event.toolName, 128) || "unknown",
          status: "running",
          inputText: argsText,
          ...(serializedInput.length <= MAX_TOOL_INPUT_CHARS ? { input } : {}),
          startedAt: Date.now(),
        });
        this.toolRows.set(id, row.rowId);
        if (this.toolRows.size > MAX_TRACKED_TOOLS) {
          const oldestId = this.toolRows.keys().next().value as string | undefined;
          if (oldestId) this.finishIncompleteTool(oldestId);
        }
        break;
      }
      case "tool_execution_update": {
        if (this.settled) break;
        const id = boundedText(event.toolCallId, 256);
        const rowId = this.toolRows.get(id);
        if (!id || rowId === undefined || this.finishedTools.has(id)) break;
        const output = messageText(event.partialResult?.content).slice(0, MAX_TOOL_OUTPUT_CHARS);
        this.upsert(rowId, { output: { text: output } });
        break;
      }
      case "tool_execution_end": {
        if (this.settled) break;
        const id = boundedText(event.toolCallId, 256);
        if (!id || this.finishedTools.has(id)) break;
        let rowId = this.toolRows.get(id);
        if (rowId === undefined) {
          const row = this.append("toolCall", {
            toolCallId: id,
            toolName: boundedText(event.toolName, 128) || "unknown",
            status: "running",
            inputText: "{}",
            input: {},
            startedAt: Date.now(),
          });
          rowId = row.rowId;
        }
        const failed = event.isError === true;
        const output = messageText(event.result?.content).slice(0, MAX_TOOL_OUTPUT_CHARS);
        this.upsert(rowId, {
          status: failed ? "error" : "success",
          output: { text: output },
          ...(failed
            ? { error: { code: "pi.tool_error", message: output.slice(0, 500) || "Tool failed" } }
            : {}),
          endedAt: Date.now(),
        });
        this.toolRows.delete(id);
        this.rememberFinishedTool(id);
        break;
      }
      case "agent_settled": {
        if (this.settled) break;
        this.settled = true;
        for (const id of this.toolRows.keys()) this.finishIncompleteTool(id);
        const interrupted = this.runOutcome === "aborted";
        const failed = this.runOutcome === "error";
        if (this.turnHeaderId !== null) {
          this.upsert(this.turnHeaderId, {
            state: interrupted ? "completedInterrupted" : failed ? "failed" : "completedSuccess",
            endedAt: Date.now(),
          });
        }
        const phase = interrupted ? "completedInterrupted" : failed ? "error" : "completedSuccess";
        this.setRunState(phase, false);
        return { terminal: interrupted ? "aborted" : failed ? "error" : "idle" };
      }
      case "agent_end":
        // A retry can follow agent_end; only agent_settled closes a Pi turn.
        break;
      default:
        break;
    }
    return {};
  }

  private finishIncompleteTool(id: string): void {
    const rowId = this.toolRows.get(id);
    if (rowId !== undefined) {
      this.upsert(rowId, {
        status: "error",
        error: {
          code: "pi.tool_lifecycle_incomplete",
          message: "Pi settled before this tool execution ended.",
        },
        endedAt: Date.now(),
      });
    }
    this.toolRows.delete(id);
    this.rememberFinishedTool(id);
  }

  private rememberFinishedTool(id: string): void {
    this.finishedTools.add(id);
    if (this.finishedTools.size > MAX_TRACKED_TOOLS * 2) {
      const oldestId = this.finishedTools.values().next().value as string | undefined;
      if (oldestId) this.finishedTools.delete(oldestId);
    }
  }
}
