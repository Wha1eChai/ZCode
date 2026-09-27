export type PiToolMode = "read-only" | "full";

const USAGE = "Usage: pi-ui-host [--tool-mode read-only|full]";

export function resolvePiToolMode(value: unknown): PiToolMode {
  if (value === undefined || value === "read-only") return "read-only";
  if (value === "full") return "full";
  throw new Error(`Unknown Pi tool mode. ${USAGE}`);
}

export function parseToolModeArgs(args: readonly string[]): PiToolMode {
  if (args.length === 0) return "read-only";
  if (args.length !== 2 || args[0] !== "--tool-mode") {
    throw new Error(`Invalid Pi UI host arguments. ${USAGE}`);
  }
  return resolvePiToolMode(args[1]);
}
