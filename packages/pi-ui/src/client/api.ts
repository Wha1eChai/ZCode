import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
  type SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";

export type PiHostPhase =
  | SessionPhase
  | "starting"
  | "submitting"
  | "stopping"
  | "aborted"
  | "idle";

export type PiToolMode = "read-only" | "full";

export interface PiViewState {
  toolMode: PiToolMode;
  sessionId: string;
  model: string | null;
  phase: PiHostPhase;
  streaming: boolean;
  snapshot: ConversationSnapshot;
  generation: number;
}

export interface SnapshotEvent {
  type: "snapshot";
  state: PiViewState;
}

export function shouldClearStopRequested(state: Pick<PiViewState, "phase" | "streaming">): boolean {
  return !state.streaming && state.phase !== "submitting" && state.phase !== "stopping";
}

export function resolveCapabilityBase(pathname: string): string | null {
  const token = pathname.split("/").filter(Boolean)[0];
  return token && /^[A-Za-z0-9_-]+$/u.test(token) ? `/${token}` : null;
}

export function parsePiViewState(value: unknown): PiViewState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const snapshotResult = conversationSnapshotSchema.safeParse(candidate.snapshot);
  const validPhases: readonly string[] = [
    "draft",
    "prewarming",
    "running",
    "completedSuccess",
    "completedInterrupted",
    "error",
    "starting",
    "submitting",
    "stopping",
    "aborted",
    "idle",
  ];
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    !(typeof candidate.model === "string" || candidate.model === null) ||
    typeof candidate.phase !== "string" ||
    !validPhases.includes(candidate.phase) ||
    typeof candidate.streaming !== "boolean" ||
    (candidate.toolMode !== "read-only" && candidate.toolMode !== "full") ||
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0 ||
    !snapshotResult.success ||
    snapshotResult.data.sessionId !== candidate.sessionId
  ) {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    model: candidate.model,
    phase: candidate.phase as PiHostPhase,
    streaming: candidate.streaming,
    toolMode: candidate.toolMode,
    snapshot: snapshotResult.data,
    generation: candidate.generation as number,
  };
}

export function parseSnapshotEvent(data: string): PiViewState | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const event = value as Record<string, unknown>;
    return event.type === "snapshot" ? parsePiViewState(event.state) : null;
  } catch {
    return null;
  }
}

export async function readPiViewState(url: string, signal?: AbortSignal): Promise<PiViewState> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Could not load Pi session state (HTTP ${response.status}).`);

  const state = parsePiViewState(await response.json());
  if (!state) throw new Error("The Pi session returned an invalid state snapshot.");
  return state;
}

export async function postPiCommand(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Pi request was rejected (HTTP ${response.status}).`);
}
