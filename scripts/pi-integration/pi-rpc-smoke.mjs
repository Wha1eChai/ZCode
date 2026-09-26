#!/usr/bin/env node
/**
 * Read-only Pi RPC integration smoke test. No dependencies, no ZCode/Grok changes.
 *
 * node scripts/pi-integration/pi-rpc-smoke.mjs         # state probe; no model call
 * node scripts/pi-integration/pi-rpc-smoke.mjs --live  # read-only model/tool turn
 * PI_CLI_PATH=/path/to/cli.js node scripts/pi-integration/pi-rpc-smoke.mjs --live
 *
 * The live probe may send this workspace path and mise.toml contents to the
 * configured model provider. It disables discovered extensions and project context.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const live = process.argv.includes("--live");
if (process.argv.slice(2).some((arg) => arg !== "--live")) {
  console.error("Usage: node scripts/pi-integration/pi-rpc-smoke.mjs [--live]");
  process.exit(2);
}
const defaultCli = process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
  : null;
const cliPath = process.env.PI_CLI_PATH ? resolve(process.env.PI_CLI_PATH) : defaultCli;
if (!cliPath || !existsSync(cliPath)) {
  console.error("Set PI_CLI_PATH to the installed Pi dist/bundle/cli.js file.");
  process.exit(2);
}

const args = [
  cliPath, "--mode", "rpc", "--no-session", "--no-approve", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read",
  "--offline",
];
if (live) {
  args.push("--model", process.env.PI_SMOKE_MODEL || "local-proxy/gpt-6-luna", "--thinking", "off");
}
const child = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const decoder = new StringDecoder("utf8");
const pending = new Map();
const events = [];
const failures = [];
let stdoutBuffer = "";
let stderr = "";
let settled;
let resolveSettled;
const settledPromise = new Promise((resolvePromise) => { resolveSettled = resolvePromise; });
let closed = false;
let fatal;
const deadline = setTimeout(() => {
  fatal = new Error("Pi RPC smoke test timed out");
  child.kill();
}, live ? 120_000 : 20_000);

function send(type, payload = {}) {
  if (closed) return Promise.reject(new Error("Pi RPC process exited"));
  const id = `smoke-${pending.size + events.length + 1}`;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n", (error) => {
      if (error) {
        pending.delete(id);
        rejectPromise(error);
      }
    });
  });
}

function receive(record) {
  if (record.type === "response" && pending.has(record.id)) {
    const waiter = pending.get(record.id);
    pending.delete(record.id);
    if (record.success) waiter.resolve(record.data ?? {});
    else waiter.reject(new Error(`${record.command}: ${record.error}`));
    return;
  }
  if (record.type === "response" && !record.success) failures.push(`unmatched response: ${record.error}`);
  if (record.type === "extension_ui_request") {
    failures.push(`unexpected extension UI request: ${record.method}`);
    if (["select", "confirm", "input", "editor"].includes(record.method)) {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true }) + "\n");
    }
  }
  events.push(record);
  if (record.type === "agent_settled") {
    settled = true;
    resolveSettled();
  }
}
child.stdout.on("data", (chunk) => {
  stdoutBuffer += decoder.write(chunk);
  let end;
  while ((end = stdoutBuffer.indexOf("\n")) !== -1) {
    const line = stdoutBuffer.slice(0, end).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(end + 1);
    if (!line) continue;
    try { receive(JSON.parse(line)); }
    catch (error) { failures.push(`Invalid JSONL record: ${error.message}`); }
  }
});
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
child.on("error", (error) => { fatal = error; });
child.on("close", (code) => {
  closed = true;
  clearTimeout(deadline);
  for (const waiter of pending.values()) waiter.reject(fatal || new Error(`Pi RPC exited: ${code}; ${stderr}`));
  pending.clear();
  resolveSettled();
});

try {
  const initial = await send("get_state");
  if (!initial.sessionId || initial.isStreaming) throw new Error("Unexpected initial Pi state");
  console.log(`RPC ready: session=${initial.sessionId}, model=${initial.model?.id ?? "none"}`);
  if (live) {
    // Listener is active before sending: never mistake a prompt ACK for turn completion.
    await send("prompt", {
      message: "Use the read tool once to read mise.toml. Then reply with only the Node version specified there. Do not edit files or call any other tools.",
    });
    await settledPromise;
    if (!settled) throw fatal || new Error(`Pi exited before agent_settled: ${stderr}`);
    const state = await send("get_state");
    const { messages } = await send("get_messages");
    const tools = events.filter((e) => e.type === "tool_execution_end");
    const assistant = messages.filter((m) => m.role === "assistant");
    const last = assistant.at(-1);
    const text = last?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
    const counts = Object.fromEntries([...new Set(events.map((e) => e.type))].map((type) => [type, events.filter((e) => e.type === type).length]));
    console.log(JSON.stringify({ eventCounts: counts, tools: tools.map((e) => ({ name: e.toolName, isError: e.isError })),
      final: text.slice(0, 300), stopReason: last?.stopReason, messageCount: messages.length,
      isStreaming: state.isStreaming, sessionFile: state.sessionFile ?? null }, null, 2));
    if (!events.some((e) => e.type === "tool_execution_start" && e.toolName === "read") ||
        !tools.some((e) => e.toolName === "read" && !e.isError)) failures.push("Missing read tool lifecycle");
    if (!events.some((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta")) {
      failures.push("Missing streaming text delta");
    }
    if (!text.includes("24.14.0")) failures.push("Final response did not contain the expected fixture version");
    if (state.isStreaming || !events.some((e) => e.type === "message_end")) failures.push("Incomplete conversation lifecycle");
  }
  if (failures.length) throw new Error(failures.join("; "));
  console.log(live ? "PASS: Pi RPC live read-only turn" : "PASS: Pi RPC state probe (no model call)");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (stderr) console.error(`Pi stderr (tail): ${stderr}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  if (!closed) {
    await Promise.race([
      new Promise((resolvePromise) => child.once("close", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(() => { child.kill(); resolvePromise(); }, 3000)),
    ]);
  }
  clearTimeout(deadline);
}
