import type { IncomingMessage } from "node:http";
import { json, readJsonBody, type HttpResponse } from "./http-utils.js";
import { PiRpcCommandError, PiRpcProcess } from "./pi-rpc.js";
import { PiV4Projection } from "./projection.js";
import { isExactObject, safePiErrorMessage } from "./request-utils.js";

const MAX_PROMPT_CHARS = 8_000;
export type Admission = { accepted: boolean; stopRequested: boolean; terminal: boolean };

export class AdmissionStopFlights {
  // Admission 对象是 stop flight 的身份；旧 turn 的 ACK 清理不能触碰新 turn 的 flight。
  private readonly flights = new WeakMap<Admission, Promise<boolean>>();

  get(active: Admission): Promise<boolean> | null {
    return this.flights.get(active) ?? null;
  }

  set(active: Admission, flight: Promise<boolean> | null): void {
    if (flight) this.flights.set(active, flight);
    else this.flights.delete(active);
  }
}

export type PostRouteContext = {
  ready: Promise<void>;
  child: PiRpcProcess;
  getProjection(): PiV4Projection | null;
  available(): boolean;
  current(): Admission | null;
  reserve(): Admission;
  release(active: Admission): void;
  isStreaming(): boolean;
  update(
    phase: "idle" | "draft" | "submitting" | "running" | "stopping" | "error",
    streaming: boolean,
  ): void;
  runStop(active: Admission): Promise<void>;
  getStopFlight(active: Admission): Promise<boolean> | null;
  setStopFlight(active: Admission, flight: Promise<boolean> | null): void;
  failClosed(): void;
  rpcCommandTimeoutMs?: number;
};

export async function handlePostRoute(
  request: IncomingMessage,
  response: HttpResponse,
  route: string,
  ctx: PostRouteContext,
): Promise<void> {
  if (request.method !== "POST" || (route !== "prompt" && route !== "stop")) {
    json(response, 404, { error: "Not found." });
    return;
  }
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    json(response, 415, { error: "Content-Type must be application/json." });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(request, 16 * 1024)) as Record<string, unknown>;
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Invalid JSON body." });
    return;
  }
  if (route === "stop" && !isExactObject(body, [])) {
    json(response, 400, { error: "Stop body must be an empty object." });
    return;
  }
  try {
    await ctx.ready;
  } catch {
    json(response, 503, { error: "Pi session is unavailable." });
    return;
  }
  const startStopFlight = (active: Admission): Promise<boolean> => {
    const flight = ctx
      .runStop(active)
      .then(
        () => true,
        () => {
          ctx.failClosed();
          return false;
        },
      )
      .finally(() => ctx.setStopFlight(active, null));
    ctx.setStopFlight(active, flight);
    return flight;
  };

  if (route === "prompt") {
    if (
      !isExactObject(body, ["message"]) ||
      typeof body.message !== "string" ||
      !body.message.trim() ||
      body.message.length > MAX_PROMPT_CHARS
    ) {
      json(response, 400, {
        error: "Prompt message must contain 1–8000 non-whitespace characters.",
      });
      return;
    }
    const projection = ctx.getProjection();
    if (!ctx.available() || !projection) {
      json(response, 503, { error: "Pi session is unavailable." });
      return;
    }
    if (ctx.isStreaming() || ctx.current()) {
      json(response, 409, { error: "A Pi turn is already running." });
      return;
    }
    // Admission is reserved before the first await so concurrent prompts cannot both enter Pi.
    const active = ctx.reserve();
    ctx.update("submitting", false);
    projection.setRunState("draft", false);
    try {
      await ctx.child.request("prompt", { message: body.message }, ctx.rpcCommandTimeoutMs);
    } catch (error) {
      const rejected = error instanceof PiRpcCommandError && error.rejected;
      if (rejected && ctx.current() === active) {
        ctx.release(active);
        ctx.update("idle", false);
        projection.setRunState("draft", false);
      } else if (!rejected) {
        // ACK 不确定时先同步关闭 admission，避免子进程退出事件前接受第二条 prompt。
        ctx.failClosed();
      }
      json(response, rejected ? 502 : 503, { error: safePiErrorMessage(error) });
      return;
    }
    active.accepted = true;
    if (ctx.current() === active && active.terminal) ctx.release(active);
    if (ctx.current() === active && !active.terminal) {
      ctx.update("running", true);
      projection.setRunState("running", true);
      if (active.stopRequested) startStopFlight(active);
    }
    json(response, 202, { accepted: true });
    return;
  }
  const active = ctx.current();
  if (!active || active.terminal) return json(response, 200, { stopped: true, pending: false });
  if (!active.accepted) {
    active.stopRequested = true;
    return json(response, 200, { stopped: false, pending: true });
  }
  if (!ctx.isStreaming()) return json(response, 200, { stopped: true, pending: false });
  const flight = ctx.getStopFlight(active) ?? startStopFlight(active);
  if (!(await flight)) {
    json(response, 503, { error: "Pi RPC process is unavailable." });
    return;
  }
  json(response, 200, { stopped: active.terminal, pending: !active.terminal });
}
