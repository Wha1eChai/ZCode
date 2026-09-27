import type { IncomingMessage } from "node:http";
import type { PiToolMode } from "./tool-mode.js";
import { json, serveStaticAsset, type HttpResponse } from "./http-utils.js";

type ReadViewState = {
  sessionId: string;
  model: string | null;
  toolMode: PiToolMode;
  phase: string;
  streaming: boolean;
  snapshot: unknown;
  generation: number;
};

export type ReadRouteDependencies = {
  ready: Promise<void>;
  state: () => ReadViewState | null;
  listeners: Set<HttpResponse>;
  staticRoot: string;
  token: string;
};

export async function handleReadRoute(
  request: IncomingMessage,
  response: HttpResponse,
  route: string,
  dependencies: ReadRouteDependencies,
): Promise<boolean> {
  const { ready, state, listeners, staticRoot, token } = dependencies;
  if (request.method !== "GET") return false;
  if (route === "state" || route === "events") {
    try {
      await ready;
    } catch {
      json(response, 503, { error: "Pi session is unavailable." });
      return true;
    }
    const current = state();
    if (!current) {
      json(response, 503, { error: "Pi session is unavailable." });
      return true;
    }
    if (route === "state") {
      json(response, 200, current);
      return true;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`data: ${JSON.stringify({ type: "snapshot", state: current })}\n\n`);
    listeners.add(response);
    response.on("close", () => listeners.delete(response));
    return true;
  }
  if (route === "" || route.startsWith("assets/") || route.startsWith("material-icons/")) {
    await serveStaticAsset(response, staticRoot, route, token);
    return true;
  }
  return false;
}
