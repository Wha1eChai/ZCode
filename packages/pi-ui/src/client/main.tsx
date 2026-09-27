import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowRenderContext } from "@zcode/ui/pi-conversation-timeline";
import {
  ConversationTimeline,
  DEFAULT_CODE_PREVIEW_SETTINGS,
  TooltipProvider,
  ZCodeIntlProvider,
} from "@zcode/ui/pi-conversation-timeline";
import "@zcode/ui/styles.css";
import {
  parseSnapshotEvent,
  postPiCommand,
  readPiViewState,
  resolveCapabilityBase,
  shouldClearStopRequested,
  type PiViewState,
} from "./api.js";

const BASE = resolveCapabilityBase(window.location.pathname);
const STOPPED_PHASES = new Set(["completedSuccess", "completedInterrupted", "error"]);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The Pi session could not be reached. Check that the local Pi host is still running.";
}

function PiConversationApp() {
  const [state, setState] = useState<PiViewState | null>(null);
  const [error, setError] = useState<string | null>(
    BASE ? null : "This Pi session link is invalid.",
  );
  const [message, setMessage] = useState("");
  const [promptPending, setPromptPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const generationRef = useRef(-1);
  const requestVersionRef = useRef(0);
  const promptFlightRef = useRef(false);
  const stopFlightRef = useRef(false);

  const applyState = useCallback((next: PiViewState) => {
    if (next.generation < generationRef.current) return;
    generationRef.current = next.generation;
    setState(next);
    if (shouldClearStopRequested(next)) setStopRequested(false);
    setError(null);
  }, []);

  const showError = useCallback((message: string) => {
    setError(message);
  }, []);

  const resync = useCallback(
    async (signal?: AbortSignal) => {
      if (!BASE) return;
      const requestVersion = ++requestVersionRef.current;
      const next = await readPiViewState(`${BASE}/state`, signal);
      if (signal?.aborted || requestVersion !== requestVersionRef.current) return;
      applyState(next);
    },
    [applyState],
  );

  useEffect(() => {
    if (!BASE) return;
    const controller = new AbortController();
    const source = new EventSource(`${BASE}/events`);

    const handleSnapshot = (event: MessageEvent<string>) => {
      const next = parseSnapshotEvent(event.data);
      if (next) {
        applyState(next);
      } else {
        showError("The Pi host sent an invalid session update.");
      }
    };
    const handleNamedSnapshot = (event: Event) => {
      if (event instanceof MessageEvent) handleSnapshot(event as MessageEvent<string>);
    };
    const handleOpen = () => {
      showError("Connection to the Pi host is live; synchronizing session state…");
      // Reconnects have no replay cursor in this slice; always replace from a full snapshot.
      void resync(controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted) showError(getErrorMessage(cause));
      });
    };
    const handleDisconnect = () => {
      if (!controller.signal.aborted) {
        showError("Connection to the Pi host was lost. Reconnecting…");
      }
    };

    source.addEventListener("snapshot", handleNamedSnapshot);
    source.addEventListener("message", handleSnapshot as EventListener);
    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleDisconnect);

    // The EventSource open event confirms the server registered this subscriber before the
    // initial state GET; generation fencing prevents that GET from overwriting a newer event.

    return () => {
      controller.abort();
      source.removeEventListener("snapshot", handleNamedSnapshot);
      source.removeEventListener("message", handleSnapshot as EventListener);
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleDisconnect);
      source.close();
      requestVersionRef.current++;
    };
  }, [applyState, resync, showError]);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const submittedMessage = message.trim();
      if (!BASE || !submittedMessage || promptFlightRef.current || stopFlightRef.current) return;

      // Lock synchronously for this event loop turn; do not show an optimistic transcript row.
      promptFlightRef.current = true;
      setPromptPending(true);
      try {
        await postPiCommand(`${BASE}/prompt`, { message: submittedMessage });
        setMessage("");
        setError(null);
        void resync().catch((cause: unknown) => {
          setError(
            `The prompt was accepted, but the session view could not refresh: ${getErrorMessage(cause)}`,
          );
        });
      } catch (cause) {
        setError(getErrorMessage(cause));
      } finally {
        promptFlightRef.current = false;
        setPromptPending(false);
      }
    },
    [message, resync],
  );

  const stop = useCallback(async () => {
    if (!BASE || stopFlightRef.current) return;
    stopFlightRef.current = true;
    setStopPending(true);
    try {
      await postPiCommand(`${BASE}/stop`, {});
      setStopRequested(true);
      setError(null);
      void resync().catch((cause: unknown) => {
        setError(
          `The stop request was accepted, but the session view could not refresh: ${getErrorMessage(cause)}`,
        );
      });
    } catch (cause) {
      setStopRequested(false);
      setError(getErrorMessage(cause));
    } finally {
      stopFlightRef.current = false;
      setStopPending(false);
    }
  }, [resync]);

  const snapshot = state?.snapshot ?? null;
  const rows = snapshot?.rows.window ?? [];
  const phase: SessionPhase =
    snapshot?.control.phase ??
    (state?.phase === "aborted"
      ? "completedInterrupted"
      : state?.phase === "idle"
        ? "completedSuccess"
        : state?.phase === "stopping"
          ? "running"
          : state?.phase === "starting" || state?.phase === "submitting"
            ? "prewarming"
            : state?.phase === "running"
              ? "running"
              : "prewarming");
  const streaming = state?.streaming ?? phase === "running";
  const canStop = promptPending || (streaming && !STOPPED_PHASES.has(phase));
  const visibleError =
    error ?? (phase === "error" ? "Pi reported an error for this session." : null);

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      sessionId: state?.sessionId,
      rootSessionId: state?.sessionId,
      workspacePath: "",
      theme: "dark",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      messageStreamShowReasoning: false,
      messageStreamShowTodos: false,
      toolGroupingChangesEnabled: false,
      toolGroupingExploreEnabled: false,
      toolGroupingTerminalEnabled: false,
    }),
    [state?.sessionId],
  );

  return (
    <TooltipProvider>
      <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Pi conversation</h1>
            <p className="truncate text-xs text-foreground-subtle">
              {state?.model ? `${state.model} · ` : ""}
              {state ? `Session ${state.sessionId}` : "Connecting to local Pi session"}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span
              className={`rounded-full border px-2.5 py-1 text-xs ${
                state?.toolMode === "full"
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-border text-foreground-subtle"
              }`}
              aria-label={`Tool mode: ${state?.toolMode ?? "pending"}`}
            >
              {state?.toolMode === "full"
                ? "Shell & write"
                : state?.toolMode === "read-only"
                  ? "Read-only tools"
                  : "Tool mode pending"}
            </span>
            <span
              className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground-subtle"
              aria-live="polite"
            >
              {phase === "error" ? "Error" : streaming ? "Running" : "Idle"}
            </span>
          </div>
        </header>

        {visibleError ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground sm:px-6"
          >
            <p>{visibleError}</p>
            <button
              type="button"
              className="mt-2 min-h-9 rounded-md border border-border px-3 text-sm hover:bg-accent"
              onClick={() =>
                void resync().catch((cause: unknown) => setError(getErrorMessage(cause)))
              }
            >
              Retry connection
            </button>
          </div>
        ) : null}

        <section className="flex min-h-0 flex-1 flex-col" aria-label="Conversation">
          <ConversationTimeline
            rows={rows}
            totalCount={snapshot?.rows.totalCount ?? rows.length}
            sessionKey={state?.sessionId ?? "pi-session-loading"}
            rowContext={rowContext}
            sessionPhase={phase}
            emptyState={
              <p className="mx-auto max-w-md px-6 py-12 text-center text-sm text-foreground-subtle">
                Send a message to start this Pi session.
              </p>
            }
            bottomDock={
              <form className="mx-auto w-full max-w-4xl" onSubmit={(event) => void submit(event)}>
                <div className="mb-3 rounded-xl border border-border bg-card px-3 py-2 text-ui-sm leading-relaxed text-foreground-subtle">
                  <p>Anyone with this capability URL can submit prompts. Keep this URL private.</p>
                  {state?.toolMode === "full" ? (
                    <p className="mt-1">
                      This mode allows shell commands and file modifications using this OS account's
                      permissions, with no per-tool approval. Reads are not limited to the current
                      working directory.
                    </p>
                  ) : state?.toolMode === "read-only" ? (
                    <p className="mt-1">
                      Pi's read tools can access files available to this OS account, not just this
                      workspace; reads are not limited to the current working directory.
                    </p>
                  ) : (
                    <p className="mt-1">
                      Tool permissions will appear when host state is available.
                    </p>
                  )}
                </div>
                <label className="sr-only" htmlFor="pi-prompt">
                  Message Pi
                </label>
                <textarea
                  id="pi-prompt"
                  className="min-h-24 w-full resize-y rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Message Pi…"
                  value={message}
                  onChange={(event) => setMessage(event.currentTarget.value)}
                  disabled={promptPending || stopPending || streaming}
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-xs text-foreground-subtle">
                    Single local session · not persisted by this UI
                  </p>
                  <div className="flex gap-2">
                    {canStop ? (
                      <button
                        type="button"
                        className="min-h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void stop()}
                        disabled={stopPending || stopRequested}
                      >
                        {stopPending || stopRequested ? "Stopping…" : "Stop"}
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !message.trim() || promptPending || stopPending || streaming || !state
                      }
                    >
                      {promptPending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
              </form>
            }
          />
        </section>
      </main>
    </TooltipProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing Pi UI root element.");

createRoot(rootElement).render(
  <StrictMode>
    <ZCodeIntlProvider initialLocale="en-US">
      <PiConversationApp />
    </ZCodeIntlProvider>
  </StrictMode>,
);
