import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcProcess, PI_RPC_STARTUP_TIMEOUT_MS } from "./pi-rpc.js";
import { resolvePiToolMode, type PiToolMode } from "./tool-mode.js";
import { closePiRpc } from "./process-lifecycle.js";
import { PiV4Projection } from "./projection.js";
import type { ConversationSnapshot, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  assertBuiltClientDirectory,
  json,
  setSecureHeaders,
  type HttpResponse,
} from "./http-utils.js";
import { AdmissionStopFlights, handlePostRoute, type Admission } from "./post-routes.js";
import { handleReadRoute } from "./read-routes.js";
import {
  assertPiCliReadable,
  boundedPathname,
  requestOrigin,
  resolvePiCliPath,
} from "./request-utils.js";

const CAPABILITY_TOKEN = /^[a-f\d]{48}$/u;
const SHUTDOWN_GRACE_MS = 2_000;
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
type HostPhase = SessionPhase | "starting" | "submitting" | "stopping" | "aborted" | "idle";

type BrowserState = {
  sessionId: string;
  model: string | null;
  toolMode: PiToolMode;
  phase: HostPhase;
  streaming: boolean;
  snapshot: ConversationSnapshot;
  generation: number;
};

type ActiveAdmission = Admission & { id: number };

export type PiHostOptions = {
  cliPath?: string;
  cwd?: string;
  toolMode?: PiToolMode;
  clientDirectory?: string;
  port?: number;
  /** Test seam for deterministic command-ACK failures; production keeps PiRpcProcess's default. */
  rpcCommandTimeoutMs?: number;
};

export type PiHostHandle = {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
};

export async function startPiHost(options: PiHostOptions = {}): Promise<PiHostHandle> {
  const toolMode = resolvePiToolMode(options.toolMode);
  const cliPath = resolvePiCliPath(options.cliPath);
  await assertPiCliReadable(cliPath);
  const clientDirectory = resolve(options.clientDirectory ?? join(PACKAGE_ROOT, "dist", "client"));
  await assertBuiltClientDirectory(clientDirectory);
  const staticRoot = await realpath(clientDirectory);
  const token = randomBytes(24).toString("hex");
  if (!CAPABILITY_TOKEN.test(token)) throw new Error("Could not create local access capability.");
  const routePrefix = `/${token}/`;
  const listeners = new Set<HttpResponse>();
  let generation = 0;
  let phase: HostPhase = "starting";
  let streaming = false;
  let sessionId: string | null = null;
  let model: string | null = null;
  let rpcAvailable = true;
  let projection: PiV4Projection | null = null;
  let admission: ActiveAdmission | null = null;
  let nextAdmissionId = 0;
  const stopFlights = new AdmissionStopFlights();
  let shuttingDown = false;
  let server: Server;

  const state = (): BrowserState | null => {
    if (!rpcAvailable || !sessionId || !projection) return null;
    return {
      sessionId,
      model,
      toolMode,
      phase,
      streaming,
      snapshot: projection.snapshot,
      generation,
    };
  };

  const publish = (
    patch: Partial<Omit<BrowserState, "sessionId" | "model" | "generation">> = {},
  ): void => {
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.streaming !== undefined) streaming = patch.streaming;
    generation += 1;
    const current = state();
    if (!current) return;
    const payload = `data: ${JSON.stringify({ type: "snapshot", state: current })}\n\n`;
    for (const listener of listeners) {
      if (listener.destroyed || listener.writableLength > 1024 * 1024) {
        listeners.delete(listener);
        listener.end();
        continue;
      }
      // Honor backpressure without dropping a single full-snapshot subscriber on its first write.
      listener.write(payload);
    }
  };

  let child!: PiRpcProcess;
  const markUnavailable = (): void => {
    if (!rpcAvailable) return;
    // RPC 应答不确定时 Pi 可能仍在执行；必须先关闭 admission，再响应并终止子进程。
    rpcAvailable = false;
    if (admission) admission.terminal = true;
    admission = null;
    streaming = false;
    phase = "error";
    publish();
    for (const listener of listeners) listener.end();
    listeners.clear();
    child.kill();
  };

  child = new PiRpcProcess({
    cliPath,
    cwd: options.cwd ?? WORKSPACE_ROOT,
    toolMode,
    onEvent(record) {
      const currentAdmission = admission;
      if (!projection || !currentAdmission || currentAdmission.terminal) return;
      try {
        const result = projection.observe(record);
        if (record.type === "agent_start") publish({ phase: "running", streaming: true });
        if (result.terminal) {
          currentAdmission.terminal = true;
          if (currentAdmission.accepted && admission === currentAdmission) admission = null;
          streaming = false;
          phase =
            result.terminal === "aborted"
              ? "completedInterrupted"
              : result.terminal === "error"
                ? "error"
                : "completedSuccess";
          publish();
        }
      } catch {
        currentAdmission.terminal = true;
        if (admission === currentAdmission) admission = null;
        streaming = false;
        phase = "error";
        publish();
        child.kill();
      }
    },
    onFailure() {
      if (!shuttingDown) markUnavailable();
    },
    onClose() {
      if (!shuttingDown) markUnavailable();
    },
  });

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const readyTimeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error("Pi RPC startup timed out."));
    child.kill();
  }, PI_RPC_STARTUP_TIMEOUT_MS);
  readyTimeout.unref();

  void child
    .request("get_state", {}, PI_RPC_STARTUP_TIMEOUT_MS)
    .then((initial) => {
      if (readySettled) return;
      if (typeof initial.sessionId !== "string" || !initial.sessionId) {
        readySettled = true;
        clearTimeout(readyTimeout);
        rejectReady(new Error("Pi RPC did not provide a session ID."));
        return;
      }
      sessionId = initial.sessionId;
      const piModel = initial.model;
      const modelObject =
        piModel && typeof piModel === "object" ? (piModel as Record<string, unknown>) : null;
      model = typeof modelObject?.id === "string" ? modelObject.id : null;
      projection = new PiV4Projection(
        sessionId,
        modelObject && {
          provider: typeof modelObject.provider === "string" ? modelObject.provider : undefined,
          id: model ?? undefined,
        },
        () => publish(),
      );
      phase = "idle";
      streaming = false;
      generation += 1;
      readySettled = true;
      clearTimeout(readyTimeout);
      resolveReady();
    })
    .catch(() => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimeout);
      rejectReady(new Error("Pi RPC could not initialize. Check the local Pi CLI configuration."));
    });

  const originFor = (port: number) => `http://127.0.0.1:${port}`;
  const runStop = async (active: ActiveAdmission): Promise<void> => {
    if (active.terminal || admission !== active || !streaming) return;
    phase = "stopping";
    projection?.setRunState("running", true, true);
    publish();
    await child.request("clear_queue", {}, options.rpcCommandTimeoutMs);
    if (!active.terminal && admission === active) {
      await child.request("abort", {}, options.rpcCommandTimeoutMs);
    }
  };

  const getOrigin = (): string | null => {
    const address = server.address();
    return address && typeof address === "object" ? originFor(address.port) : null;
  };

  server = createServer(async (request, response) => {
    const origin = getOrigin();
    if (!origin || !requestOrigin(request, origin, request.method === "POST")) {
      json(response, 403, { error: "Forbidden." });
      return;
    }
    const pathname = boundedPathname(request, origin);
    if (!pathname) {
      json(response, 404, { error: "Not found." });
      return;
    }
    if (!pathname.startsWith(routePrefix)) {
      json(response, 404, { error: "Not found." });
      return;
    }
    setSecureHeaders(response);
    const route = pathname.slice(routePrefix.length);

    if (
      await handleReadRoute(request, response, route, {
        ready,
        state,
        listeners,
        staticRoot,
        token,
      })
    )
      return;

    await handlePostRoute(request, response, route, {
      ready,
      child,
      getProjection: () => projection,
      available: () => rpcAvailable && sessionId !== null && !shuttingDown,
      current: () => admission,
      reserve: () => {
        const active: ActiveAdmission = {
          id: ++nextAdmissionId,
          accepted: false,
          stopRequested: false,
          terminal: false,
        };
        admission = active;
        return active;
      },
      release: (active) => {
        if (admission === active) admission = null;
      },
      isStreaming: () => streaming,
      update: (nextPhase, isStreaming) => {
        phase = nextPhase;
        streaming = isStreaming;
        publish();
      },
      runStop,
      getStopFlight: (active) => stopFlights.get(active),
      setStopFlight: (active, flight) => stopFlights.set(active, flight),
      failClosed: markUnavailable,
      rpcCommandTimeoutMs: options.rpcCommandTimeoutMs,
    });
  });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error) => rejectPromise(error);
      server.once("error", onError);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", onError);
        resolvePromise();
      });
    });
  } catch (error) {
    await closePiRpc(child, SHUTDOWN_GRACE_MS);
    throw error;
  }

  try {
    await ready;
  } catch (error) {
    server.close();
    await closePiRpc(child, SHUTDOWN_GRACE_MS);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pi host did not bind a TCP port.");
  const url = `${originFor(address.port)}${routePrefix}`;
  let closePromise: Promise<void> | null = null;

  return {
    url,
    port: address.port,
    close() {
      closePromise ??= (async () => {
        shuttingDown = true;
        for (const listener of listeners) listener.end();
        listeners.clear();
        const httpClosed = new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeIdleConnections();
        });
        await closePiRpc(child, SHUTDOWN_GRACE_MS);
        await httpClosed;
      })();
      return closePromise;
    },
  };
}
