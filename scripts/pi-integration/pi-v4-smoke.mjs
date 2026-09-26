#!/usr/bin/env node
// Read-only proof of Pi RPC -> validated ZCode V4 snapshot/delta frames.
// Run from repository root:
// pnpm exec tsx --tsconfig packages/ui/tsconfig.json scripts/pi-integration/pi-v4-smoke.mjs
// Sends mise.toml and the probe prompt to the selected model provider.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createPiV4Projection } from "./pi-v4-projection.mjs";
import { checkZCodeStore } from "./pi-v4-store-check.mjs";
import { SessionDataLayer } from "../../packages/ui/src/v4/sessionDataLayer.ts";
import * as schema from "../../packages/shared/src/zcode-protocol-v4/index.ts";

if (process.argv.length !== 2 || !existsSync("packages/shared/package.json")) {
  console.error("Usage: pnpm exec tsx --tsconfig packages/ui/tsconfig.json scripts/pi-integration/pi-v4-smoke.mjs");
  process.exit(2);
}
const cliPath = process.env.PI_CLI_PATH ? resolve(process.env.PI_CLI_PATH) : join(
  process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js",
);
if (!existsSync(cliPath)) throw new Error("Set PI_CLI_PATH to the installed Pi dist/bundle/cli.js");
const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-session", "--no-approve", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read", "--offline",
  "--model", process.env.PI_SMOKE_MODEL || "local-proxy/gpt-6-luna", "--thinking", "off"],
{ cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const decoder = new StringDecoder("utf8");
const pending = new Map();
let nextId = 0;
let buffer = "";
let stderr = "";
let projection;
let settledResolve;
let settledPromise;
let abortRequested = false;
let abortPromise;
let phase = "normal";
let closed = false;
let fatal;
const watchdog = setTimeout(() => { fatal = new Error("Pi V4 probe timed out"); child.kill(); }, 120_000);

function command(type, payload = {}) {
  const id = `v4-probe-${++nextId}`;
  return new Promise((ok, fail) => {
    pending.set(id, { ok, fail });
    child.stdin.write(JSON.stringify({ type, id, ...payload }) + "\n", (error) => {
      if (error) { pending.delete(id); fail(error); }
    });
  });
}
function startWait() {
  settledPromise = new Promise((ok) => { settledResolve = ok; });
}
function receive(record) {
  if (record.type === "response") {
    const waiter = pending.get(record.id);
    if (!waiter) { fatal = new Error(`Unexpected response: ${record.command}`); return; }
    pending.delete(record.id);
    if (record.success) waiter.ok(record.data ?? {});
    else waiter.fail(new Error(`${record.command}: ${record.error}`));
    return;
  }
  if (record.type === "extension_ui_request") {
    fatal = new Error(`Unexpected extension UI request: ${record.method}`);
    if (["select", "confirm", "input", "editor"].includes(record.method)) {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true }) + "\n");
    }
    return;
  }
  projection?.observe(record);
  if (phase === "abort" && !abortRequested && record.type === "message_update" &&
      record.assistantMessageEvent?.type === "text_delta") {
    abortRequested = true;
    // clear_queue first: abort alone is allowed to continue queued follow-ups.
    abortPromise = command("clear_queue").then(() => command("abort"));
  }
  if (record.type === "agent_settled") settledResolve?.();
}
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { receive(JSON.parse(line)); }
    catch (error) { fatal = error; child.kill(); }
  }
});
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
child.on("error", (error) => { fatal = error; });
child.on("close", (code) => {
  closed = true;
  clearTimeout(watchdog);
  for (const waiter of pending.values()) waiter.fail(fatal ?? new Error(`Pi exited ${code}: ${stderr}`));
  pending.clear();
  settledResolve?.();
});
try {
  const initial = await command("get_state");
  if (!initial.sessionId) throw new Error("Missing initial sessionId");
  projection = createPiV4Projection(schema, initial.sessionId, initial.model);
  startWait();
  await command("prompt", { message: "Read mise.toml using the read tool, then answer only the Node version from it. Do not modify files." });
  await settledPromise;
  if (fatal || closed) throw fatal ?? new Error(`Pi exited: ${stderr}`);
  const messages = (await command("get_messages")).messages;
  const text = messages.filter((m) => m.role === "assistant").at(-1)?.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
  if (!text.includes("24.14.0")) throw new Error(`Unexpected final reply: ${text.slice(0, 80)}`);
  if (!projection.snapshot.rows.window.some((r) => r.kind === "toolCall" && r.toolName === "read" && r.status === "success")) throw new Error("Read tool row missing");
  if (!projection.snapshot.rows.window.some((r) => r.kind === "assistantText" && r.text.includes("24.14.0"))) throw new Error("Final text row missing");
  if (projection.snapshot.control.phase !== "completedSuccess") throw new Error("Incorrect completion phase");
  console.log("NORMAL", JSON.stringify(projection.checkReplay()));
  const normalStore = await checkZCodeStore(SessionDataLayer, schema, projection.initial, projection.frames);
  if (JSON.stringify(normalStore.snapshot) !== JSON.stringify(projection.snapshot)) throw new Error("ZCode store differs from normal projection");
  console.log("ZCODE_STORE_NORMAL", JSON.stringify({ seq: normalStore.seq, rows: normalStore.rows }));

  // A separate ephemeral session keeps the normal and aborted turn lifecycles independent.
  const switched = await command("new_session");
  if (switched.cancelled) throw new Error("Session switch cancelled");
  const abortState = await command("get_state");
  if (abortState.sessionId === initial.sessionId) throw new Error("Session did not switch");
  projection = createPiV4Projection(schema, abortState.sessionId, abortState.model);
  phase = "abort";
  startWait();
  await command("prompt", { message: "First use read to inspect mise.toml. Then write a detailed explanation with at least 1000 words about the implications of its pinned tool versions. Do not modify files." });
  await settledPromise;
  if (abortPromise) await abortPromise;
  if (fatal || closed) throw fatal ?? new Error(`Pi exited: ${stderr}`);
  const afterAbort = await command("get_state");
  if (!abortRequested) throw new Error("No text delta appeared in time to exercise abort");
  if (afterAbort.isStreaming) throw new Error("Pi remained streaming after abort");
  const abortedMessages = (await command("get_messages")).messages;
  const wasAborted = abortedMessages.some((m) => m.role === "assistant" && m.stopReason === "aborted");
  if (!wasAborted) throw new Error("Pi did not report an aborted assistant message");
  if (projection.snapshot.control.phase !== "completedInterrupted") throw new Error("Incorrect interrupted phase");
  console.log("ABORT", JSON.stringify(projection.checkReplay()));
  const abortedStore = await checkZCodeStore(SessionDataLayer, schema, projection.initial, projection.frames);
  if (JSON.stringify(abortedStore.snapshot) !== JSON.stringify(projection.snapshot)) throw new Error("ZCode store differs from abort projection");
  console.log("ZCODE_STORE_ABORT", JSON.stringify({ seq: abortedStore.seq, rows: abortedStore.rows }));
  console.log("PASS: Pi live + abort frames accepted by ZCode SessionDataLayer/ConversationProjectionStore");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (stderr) console.error(`Pi stderr (tail): ${stderr}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  if (!closed) await Promise.race([
    new Promise((ok) => child.once("close", ok)),
    new Promise((ok) => setTimeout(() => { child.kill(); ok(); }, 3000)),
  ]);
  clearTimeout(watchdog);
}
