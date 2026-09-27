import type { IncomingMessage } from "node:http";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiRpcCommandError } from "./pi-rpc.js";

const DEFAULT_WINDOWS_PI_CLI = [
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
];

export function resolvePiCliPath(override?: string): string {
  if (override) return resolve(override);
  if (process.env.PI_CLI_PATH) return resolve(process.env.PI_CLI_PATH);
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, ...DEFAULT_WINDOWS_PI_CLI);
  }
  throw new Error("Pi CLI not found; set PI_CLI_PATH to its dist/bundle/cli.js file.");
}

export async function assertPiCliReadable(cliPath: string): Promise<void> {
  try {
    await access(cliPath, constants.R_OK);
  } catch {
    throw new Error("Pi CLI not found; set PI_CLI_PATH to its dist/bundle/cli.js file.");
  }
}

export function safePiErrorMessage(error: unknown): string {
  if (error instanceof PiRpcCommandError && error.rejected)
    return "Pi rejected the command before accepting it.";
  return "Pi RPC process is unavailable.";
}

export function isExactObject(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function boundedPathname(request: IncomingMessage, origin: string): string | null {
  const rawUrl = request.url ?? "";
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  try {
    const parsed = new URL(rawUrl, origin);
    if (parsed.origin !== origin || parsed.search || parsed.hash || parsed.pathname !== rawUrl)
      return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

export function requestOrigin(
  request: IncomingMessage,
  origin: string,
  requireOrigin: boolean,
): boolean {
  if (request.headers.host !== origin.slice("http://".length)) return false;
  const requestHeaderOrigin = request.headers.origin;
  if (requireOrigin) return requestHeaderOrigin === origin;
  return requestHeaderOrigin === undefined || requestHeaderOrigin === origin;
}
