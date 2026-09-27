#!/usr/bin/env node
// Isolated local Pi GUI probe. It intentionally does not import ZCode services.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const root = fileURLToPath(new URL("../../", import.meta.url));
const page = readFileSync(new URL("./pi-gui.html", import.meta.url));
const cli = process.env.PI_CLI_PATH ? resolve(process.env.PI_CLI_PATH) : process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js") : "";
if (!cli || !existsSync(cli)) {
  console.error("Pi CLI not found; set PI_CLI_PATH to its dist/bundle/cli.js file.");
  process.exit(2);
}
const args = [cli, "--mode", "rpc", "--no-session", "--no-approve", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,grep,find,ls", "--offline"];
if (process.env.PI_GUI_MODEL) args.push("--model", process.env.PI_GUI_MODEL);
const child = spawn(process.execPath, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const token = randomBytes(24).toString("hex");
const base = `/${token}/`;
const clients = new Set();
const decoder = new StringDecoder("utf8");
const pending = new Map();
const transcript = [];
let nextId = 0;
let buffer = "";
let phase = "starting";
let streaming = false;
let text = "";
let settledBeforeAck = false;
let stopFlight = null;
let admissionPending = false;
let promptAdmitted = false;
let stopAfterAdmission = false;
let alive = true;
let sessionId = null;
let model = null;
let server;

function publicState() {
  return { phase, streaming, sessionId, model, transcript: transcript.slice(-100),
    partial: text, note: "Ephemeral read-only Pi probe; no ZCode Host or account services." };
}
function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of clients) {
    // This experimental stream drops slow subscribers rather than buffering unbounded content.
    if (!client.write(payload)) { clients.delete(client); client.end(); }
  }
}
function fail(message) {
  phase = "error";
  streaming = false;
  broadcast("error", { message });
  broadcast("state", { phase, streaming });
}
function command(type, fields = {}) {
  if (!alive) return Promise.reject(new Error("Pi RPC process is unavailable"));
  const id = `gui-${++nextId}`;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolvePromise, rejectPromise });
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n", (error) => {
      if (error) { pending.delete(id); rejectPromise(error); }
    });
  });
}
function bounded(value, limit = 1600) { return String(value ?? "").slice(0, limit); }
function onRecord(record) {
  if (record.type === "response") {
    const waiting = pending.get(record.id);
    if (!waiting) return;
    pending.delete(record.id);
    if (record.success) waiting.resolvePromise(record.data ?? {});
    else waiting.rejectPromise(new Error(`${record.command} rejected: ${bounded(record.error, 200)}`));
    return;
  }
  if (record.type === "extension_ui_request") {
    fail("Unexpected Pi extension UI request; extension support is disabled in this probe.");
    if (["select", "confirm", "input", "editor"].includes(record.method)) {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true }) + "\n");
    }
    return;
  }
  switch (record.type) {
    case "message_start":
      if (record.message?.role === "user") {
        const content = record.message.content;
        const message = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
        transcript.push({ role: "user", text: bounded(message, 8000) });
        broadcast("message", { role: "user", text: bounded(message, 8000) });
      }
      break;
    case "message_update":
      if (record.assistantMessageEvent?.type === "text_delta") {
        text += record.assistantMessageEvent.delta;
        broadcast("text", { delta: record.assistantMessageEvent.delta });
      }
      break;
    case "message_end":
      if (record.message?.role === "assistant") {
        const final = record.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
        if (final) {
          transcript.push({ role: "assistant", text: bounded(final, 80000), stopReason: record.message.stopReason });
        }
        broadcast("message", { text: bounded(final, 80000), stopReason: record.message.stopReason });
        text = "";
        if (["error", "aborted"].includes(record.message.stopReason)) {
          phase = record.message.stopReason;
          broadcast("state", { phase, streaming });
        }
      }
      break;
    case "tool_execution_start":
    case "tool_execution_end":
      broadcast("tool", { id: bounded(record.toolCallId, 128), name: bounded(record.toolName, 80),
        status: record.type === "tool_execution_start" ? "running" : record.isError ? "error" : "done" });
      break;
    case "agent_settled":
      if (admissionPending) {
        settledBeforeAck = true;
        break;
      }
      streaming = false;
      if (!["error", "aborted"].includes(phase)) phase = "idle";
      broadcast("state", { phase, streaming });
      break;
  }
}
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  if (buffer.length > 1_000_000) { fail("Pi RPC record exceeded the size limit"); child.kill(); return; }
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { onRecord(JSON.parse(line)); }
    catch { fail("Invalid Pi RPC record"); child.kill(); return; }
  }
});
child.stderr.on("data", () => { /* Diagnostics are intentionally not exposed to the browser. */ });
child.on("error", () => { alive = false; fail("Pi RPC process could not start"); });
child.on("close", () => {
  alive = false;
  for (const waiter of pending.values()) waiter.rejectPromise(new Error("Pi RPC process exited"));
  pending.clear();
  fail("Pi RPC process exited; restart the local probe. No prompt will be retried automatically.");
});
const ready = command("get_state").then((data) => {
  sessionId = data.sessionId;
  model = data.model?.id ?? null;
  if (!sessionId) throw new Error("Pi did not provide a session ID");
  phase = "idle";
  broadcast("state", { phase, streaming });
}).catch(() => fail("Pi RPC startup failed; check your installed Pi CLI and model configuration."));

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function bodyJson(request) {
  let bytes = 0; const parts = [];
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 16_384) throw new Error("Prompt exceeds 16 KiB");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw new Error("Invalid JSON body"); }
}
server = createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pathname = new URL(request.url ?? "/", origin).pathname;
  if (request.headers.host !== `127.0.0.1:${server.address().port}`) return json(response, 403, { error: "Wrong host" });
  if (pathname === "/health") return json(response, 200, { phase, piAvailable: alive });
  if (!pathname.startsWith(base)) return json(response, 404, { error: "Not found" });
  if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: "Wrong origin" });
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  if (request.method === "GET" && pathname === base) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return response.end(page);
  }
  if (request.method === "GET" && pathname === base + "app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    return response.end(readFileSync(new URL("./pi-gui-client.js", import.meta.url)));
  }
  if (request.method === "GET" && pathname === base + "state") return json(response, 200, publicState());
  if (request.method === "GET" && pathname === base + "events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive",
      "x-accel-buffering": "no" });
    response.write(": connected\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method !== "POST" || ![base + "prompt", base + "stop"].includes(pathname)) return json(response, 404, { error: "Not found" });
  if (request.headers.origin !== origin || request.headers["content-type"]?.split(";")[0] !== "application/json") {
    return json(response, 403, { error: "Wrong origin or content type" });
  }
  try {
    const body = await bodyJson(request);
    if (pathname === base + "prompt") {
      const message = body?.message;
      if (typeof message !== "string" || !message.trim() || message.length > 8000) return json(response, 400, { error: "Message must be 1–8000 characters" });
      await ready;
      if (!alive || phase === "error") return json(response, 503, { error: "Pi is unavailable" });
      if (streaming) return json(response, 409, { error: "A turn is already running" });
      // Reserve admission synchronously, before the async Pi RPC acknowledgment.
      streaming = true; phase = "submitting"; text = "";
      admissionPending = true; promptAdmitted = false; stopAfterAdmission = false; settledBeforeAck = false;
      try {
        await command("prompt", { message });
        admissionPending = false; promptAdmitted = true;
        if (settledBeforeAck) {
          streaming = false;
          if (!["error", "aborted"].includes(phase)) phase = "idle";
        } else if (phase === "submitting") phase = "running";
        broadcast("state", { phase, streaming });
        if (stopAfterAdmission && streaming) {
          stopFlight = command("clear_queue").then(() => command("abort")).finally(() => { stopFlight = null; });
        }
        return json(response, 202, { accepted: true });
      } catch {
        admissionPending = false;
        streaming = false;
        fail("Pi rejected the prompt; input was not accepted.");
        return json(response, 502, { error: "Pi rejected the prompt; input was not accepted" });
      }
    }
    if (streaming && admissionPending) stopAfterAdmission = true;
    if (streaming && promptAdmitted && !stopFlight) {
      stopFlight = command("clear_queue").then(() => command("abort")).finally(() => { stopFlight = null; });
    }
    if (stopFlight) await stopFlight;
    return json(response, 200, { stopped: !streaming, pending: admissionPending });
  } catch (error) { return json(response, 400, { error: bounded(error.message, 160) }); }
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Pi GUI probe: http://127.0.0.1:${server.address().port}${base}`);
  console.log("Ephemeral/read-only; local URL grants access. Press Ctrl+C to stop.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close();
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2000);
  timer.unref();
});
