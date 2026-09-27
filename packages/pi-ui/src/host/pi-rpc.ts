import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { PiToolMode } from "./tool-mode.js";

const MAX_RPC_LINE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 20_000;

type RpcRecord = Record<string, unknown>;
type PendingCommand = {
  command: string;
  resolve: (data: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PiRpcCommandError extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
    this.name = "PiRpcCommandError";
  }
}

export type PiRpcProcessOptions = {
  cliPath: string;
  cwd: string;
  toolMode: PiToolMode;
  onEvent: (record: RpcRecord) => void;
  onFailure: () => void;
  onClose: () => void;
};

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private nextId = 0;
  private closed = false;
  private failureNotified = false;
  private resolveClosed!: () => void;
  readonly closedPromise = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(options: PiRpcProcessOptions) {
    const args = [
      options.cliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--tools",
      options.toolMode === "full" ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls",
      "--offline",
    ];
    this.child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk, options));
    // Pi diagnostics may contain sensitive paths or provider details. Drain only; never log or expose.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => {
      this.notifyFailure(options);
      this.rejectPending(new PiRpcCommandError("Pi RPC input stream failed", false));
    });
    this.child.on("error", () => {
      this.notifyFailure(options);
      this.rejectPending(new PiRpcCommandError("Pi RPC process could not start", false));
    });
    this.child.on("close", () => {
      this.closed = true;
      this.rejectPending(new PiRpcCommandError("Pi RPC process exited", false));
      this.resolveClosed();
      options.onClose();
    });
  }

  request(
    command: string,
    fields: Record<string, unknown> = {},
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<RpcRecord> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new PiRpcCommandError("Pi RPC process is unavailable", false));
    }
    const id = `host-${++this.nextId}-${randomUUID()}`;
    const record = JSON.stringify({ id, type: command, ...fields });
    if (Buffer.byteLength(record, "utf8") > MAX_RPC_LINE_BYTES) {
      return Promise.reject(new PiRpcCommandError("Pi RPC command exceeded its size limit", true));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcCommandError("Pi RPC command acknowledgment timed out", false));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { command, resolve, reject, timer });
      this.child.stdin.write(`${record}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new PiRpcCommandError("Pi RPC command could not be sent", false));
      });
    });
  }

  endInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  kill(): void {
    if (!this.closed) this.child.kill();
  }

  private readStdout(chunk: Buffer, options: PiRpcProcessOptions): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
        this.notifyFailure(options);
        this.kill();
        return;
      }
      if (line.length > 0) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          this.notifyFailure(options);
          this.kill();
          return;
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          this.notifyFailure(options);
          this.kill();
          return;
        }
        this.receive(record as RpcRecord, options);
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RPC_LINE_BYTES) {
      this.notifyFailure(options);
      this.kill();
    }
  }

  private receive(record: RpcRecord, options: PiRpcProcessOptions): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.command !== pending.command || typeof record.success !== "boolean") {
        pending.reject(new PiRpcCommandError("Pi RPC returned an invalid command response", false));
      } else if (record.success) {
        const data = record.data;
        pending.resolve(
          data && typeof data === "object" && !Array.isArray(data) ? (data as RpcRecord) : {},
        );
      } else {
        pending.reject(new PiRpcCommandError("Pi rejected the command", true));
      }
      return;
    }
    if (record.type === "extension_ui_request") {
      if (
        typeof record.id === "string" &&
        ["select", "confirm", "input", "editor"].includes(String(record.method))
      ) {
        this.child.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`,
        );
      }
      this.notifyFailure(options);
      this.endInput();
      return;
    }
    options.onEvent(record);
  }

  private rejectPending(error: PiRpcCommandError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private notifyFailure(options: PiRpcProcessOptions): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    options.onFailure();
  }
}

export const PI_RPC_STARTUP_TIMEOUT_MS = STARTUP_TIMEOUT_MS;
