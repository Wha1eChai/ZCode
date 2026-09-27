import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPiHost } from "./server.js";

const FAKE_PI_CLI = `
const fs = require("node:fs");
const path = require("node:path");
let id = 0;
let active = false;
let currentMessage = "";
let pendingRaceAck = null;
function output(value) { process.stdout.write(JSON.stringify(value) + "\\r\\n"); }
function respond(command, data = {}) { output({ id: command.id, type: "response", command: command.type, success: true, data }); }
function reject(command) { output({ id: command.id, type: "response", command: command.type, success: false, error: "rejected" }); }
function start(command) {
  output({ type: "agent_start" });
  output({ type: "message_start", message: { role: "user", content: command.message } });
}
function respondAfterRelease(command, filename) {
  const releasePath = path.join(process.cwd(), filename);
  let watcher;
  const check = () => {
    if (!fs.existsSync(releasePath)) return;
    watcher?.close();
    respond(command);
  };
  watcher = fs.watch(process.cwd(), (_event, name) => {
    if (name === null || name.toString() === filename) check();
  });
  check();
}
function handle(command) {
  switch (command.type) {
    case "get_state": respond(command, { sessionId: "fake-session", model: { provider: "fake", id: "fake-model" }, isStreaming: active }); break;
    case "prompt": {
      currentMessage = command.message;
      fs.appendFileSync(path.join(process.cwd(), "prompts.log"), currentMessage + "\\n");
      if (currentMessage === "reject") { reject(command); break; }
      if (currentMessage === "process-error") { process.exit(23); break; }
      active = true;
      if (currentMessage === "prompt-no-ack") break;
      if (currentMessage === "delayed-ack") {
        start(command);
        respondAfterRelease(command, "release-delayed-ack");
        break;
      }
      if (currentMessage === "settle-before-ack") {
        start(command);
        output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "settled first" }], stopReason: "stop" } });
        output({ type: "agent_settled" });
        active = false;
        respondAfterRelease(command, "release-settled-ack");
        break;
      }
      respond(command);
      start(command);
      if (currentMessage === "race-A" || currentMessage === "race-B") break;
      const call = ++id;
      output({ type: "tool_execution_start", toolCallId: "tool-" + call, toolName: "read", args: { path: "safe.txt" } });
      output({ type: "tool_execution_end", toolCallId: "tool-" + call, toolName: "read", result: { content: [{ type: "text", text: "read result" }] }, isError: false });
      output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live " } });
      setTimeout(() => { if (!active) return; output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }], stopReason: "stop" } }); active = false; output({ type: "agent_settled" }); }, 80);
      break;
    }
    case "clear_queue": {
      if (currentMessage === "fail-clear-queue") { reject(command); break; }
      if (currentMessage === "race-A") {
        pendingRaceAck = command;
        output({ type: "message_start", message: { role: "user", content: "race-A-clear-queue-received" } });
        output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A settled while clear_queue ACK is delayed" }], stopReason: "stop" } });
        output({ type: "agent_settled" });
        active = false;
        break;
      }
      if (currentMessage === "race-B") {
        output({ type: "message_start", message: { role: "user", content: "race-B-clear-queue-received" } });
        if (pendingRaceAck) {
          respond(pendingRaceAck);
          pendingRaceAck = null;
        }
      }
      respond(command, { steering: [], followUp: [] });
      break;
    }
    case "abort": {
      if (currentMessage === "fail-abort") { reject(command); break; }
      active = false;
      respond(command);
      output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" } });
      output({ type: "agent_settled" });
      break;
    }
    default: output({ id: command.id, type: "response", command: command.type, success: false, error: "unknown" });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) !== -1) { const line = buffer.slice(0, i).replace(/\\r$/, ""); buffer = buffer.slice(i + 1); if (line) handle(JSON.parse(line)); } });
process.stdin.on("end", () => process.exit(0));
`;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-host-test-"));
  const cliPath = join(root, "fake-pi.cjs");
  const clientDirectory = join(root, "client");
  await mkdir(join(clientDirectory, "assets"), { recursive: true });
  await mkdir(join(clientDirectory, "material-icons"), { recursive: true });
  await mkdir(join(clientDirectory, "private"), { recursive: true });
  await writeFile(cliPath, FAKE_PI_CLI);
  await writeFile(
    join(clientDirectory, "index.html"),
    '<!doctype html><script type="module" src="/assets/main.js"></script>',
  );
  await writeFile(join(clientDirectory, "assets", "main.js"), 'fetch("/assets/next.js")');
  await writeFile(join(clientDirectory, "assets", "next.js"), "export {};\n");
  await writeFile(
    join(clientDirectory, "material-icons", "toml.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><title>toml</title></svg>\n',
  );
  await writeFile(join(clientDirectory, "private", "secret.txt"), "private\n");
  return { root, cliPath, clientDirectory };
}

async function requestWithPath(url: URL, path: string, host: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(url.port),
        path,
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function requestWithHost(url: URL, host: string): Promise<number> {
  return await requestWithPath(url, url.pathname, host);
}

async function postJson(
  host: { url: string },
  route: string,
  body: unknown = {},
): Promise<Response> {
  return await fetch(`${host.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(host.url).origin },
    body: JSON.stringify(body),
  });
}

async function readUntilState(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialBuffer: string,
  predicate: (state: Record<string, any>) => boolean,
): Promise<{ state: Record<string, any>; remainder: string }> {
  let buffer = initialBuffer;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for the Pi host event.")), 5_000);
  });
  try {
    while (true) {
      const next = await Promise.race([readEvent(reader, buffer), timeout]);
      buffer = next.remainder;
      if (predicate(next.event.state)) return { state: next.event.state, remainder: buffer };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: string,
): Promise<{ event: Record<string, any>; remainder: string }> {
  const decoder = new TextDecoder();
  let data = buffer;
  while (!data.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Pi host event stream closed unexpectedly.");
    data += decoder.decode(next.value, { stream: true });
  }
  const boundary = data.indexOf("\n\n");
  const frame = data.slice(0, boundary);
  const jsonLine = frame.split("\n").find((line) => line.startsWith("data: "));
  if (!jsonLine) throw new Error("SSE snapshot data line was missing.");
  return { event: JSON.parse(jsonLine.slice(6)), remainder: data.slice(boundary + 2) };
}

test("loopback Pi host scopes static files, guards POST origin, streams projection, and stops after accepted prompt", async () => {
  const fixture = await createFixture();
  const host = await startPiHost({
    cliPath: fixture.cliPath,
    clientDirectory: fixture.clientDirectory,
    cwd: fixture.root,
  });
  try {
    const origin = `http://127.0.0.1:${host.port}`;
    assert.equal(new URL(host.url).pathname.split("/").filter(Boolean)[0]?.length, 48);
    const pageResponse = await fetch(host.url);
    const pageText = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(pageText, new RegExp(`${new URL(host.url).pathname}assets/main\\.js`));
    const assetPath = `${new URL(host.url).pathname}assets/main.js`;
    const asset = await fetch(new URL(assetPath, origin));
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), new RegExp(new URL(host.url).pathname));

    const icon = await fetch(`${host.url}material-icons/toml.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.match(await icon.text(), /<title>toml<\/title>/);
    const token = new URL(host.url).pathname.split("/")[1]!;
    const wrongToken = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
    const unscopedIcon = await fetch(`${origin}/${wrongToken}/material-icons/toml.svg`);
    assert.equal(unscopedIcon.status, 404);
    const privateFile = await fetch(`${host.url}private/secret.txt`);
    assert.equal(privateFile.status, 404, "static reads must not expose arbitrary paths");
    const traversalPath = `${new URL(host.url).pathname}material-icons/%2e%2e%2fassets/main.js`;
    assert.equal(
      await requestWithPath(new URL(host.url), traversalPath, new URL(host.url).host),
      404,
      "encoded traversal out of material-icons must be rejected",
    );

    const stateResponse = await fetch(`${host.url}state`);
    const initialState = await stateResponse.json();
    assert.equal(stateResponse.status, 200);
    assert.deepEqual(Object.keys(initialState).sort(), [
      "generation",
      "model",
      "phase",
      "sessionId",
      "snapshot",
      "streaming",
    ]);
    assert.equal(initialState.snapshot.sessionId, initialState.sessionId);

    const noOrigin = await fetch(`${host.url}stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(await requestWithHost(new URL(`${host.url}state`), "localhost"), 403);
    const wrongOrigin = await fetch(`${host.url}stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:1" },
      body: "{}",
    });
    assert.equal(wrongOrigin.status, 403);
    const wrongContentType = await fetch(`${host.url}stop`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: origin },
      body: "{}",
    });
    assert.equal(wrongContentType.status, 415);

    const eventsResponse = await fetch(`${host.url}events`);
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = eventsResponse.body!.getReader();
    let eventBuffer = "";
    let first = await readEvent(reader, eventBuffer);
    eventBuffer = first.remainder;
    assert.equal(first.event.type, "snapshot");

    const prompt = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "show tool output" }),
    });
    assert.equal(prompt.status, 202);
    let gotFinal = false;
    for (let attempt = 0; attempt < 20 && !gotFinal; attempt += 1) {
      const next = await readEvent(reader, eventBuffer);
      eventBuffer = next.remainder;
      const state = next.event.state;
      const assistant = state.snapshot.rows.window.find((row: any) => row.kind === "assistantText");
      gotFinal =
        assistant?.text === "final answer" &&
        state.phase === "completedSuccess" &&
        state.streaming === false;
      if (assistant?.text === "final answer") assert.equal(assistant.state, "complete");
    }
    assert.equal(gotFinal, true, "message_end content and agent_settled phase should reach SSE");

    const delayedPrompt = postJson(host, "prompt", { message: "delayed-ack" });
    let currentEvent = await readUntilState(
      reader,
      eventBuffer,
      (state) => state.phase === "submitting",
    );
    eventBuffer = currentEvent.remainder;
    const duplicatePrompt = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "must not enter while admission is pending" }),
    });
    assert.equal(duplicatePrompt.status, 409, "admission must be reserved before the RPC ACK");
    const deferredStop = await fetch(`${host.url}stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.deepEqual(await deferredStop.json(), { stopped: false, pending: true });
    await writeFile(join(fixture.root, "release-delayed-ack"), "release");
    assert.equal((await delayedPrompt).status, 202);
    currentEvent = await readUntilState(
      reader,
      eventBuffer,
      (state) => state.phase === "completedInterrupted" && state.streaming === false,
    );
    eventBuffer = currentEvent.remainder;

    const settledBeforeAckRequest = postJson(host, "prompt", { message: "settle-before-ack" });
    currentEvent = await readUntilState(
      reader,
      eventBuffer,
      (state) =>
        state.phase === "completedSuccess" &&
        state.streaming === false &&
        state.snapshot.rows.window.some(
          (row: any) => row.kind === "userInput" && row.text === "settle-before-ack",
        ),
    );
    eventBuffer = currentEvent.remainder;
    await writeFile(join(fixture.root, "release-settled-ack"), "release");
    const settledBeforeAck = await settledBeforeAckRequest;
    assert.equal(settledBeforeAck.status, 202);
    const afterSettledAck = await (await fetch(`${host.url}state`)).json();
    assert.equal(afterSettledAck.streaming, false);
    assert.equal(afterSettledAck.phase, "completedSuccess");

    const rejectedPrompt = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "reject" }),
    });
    assert.equal(rejectedPrompt.status, 502);
    assert.deepEqual(await rejectedPrompt.json(), {
      error: "Pi rejected the command before accepting it.",
    });
    const afterRejection = await (await fetch(`${host.url}state`)).json();
    assert.equal(
      afterRejection.phase,
      "idle",
      "rejection must roll back admission without a false turn",
    );
    assert.equal(afterRejection.streaming, false);

    const stopRun = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "stop test" }),
    });
    assert.equal(stopRun.status, 202);
    const stop = await fetch(`${host.url}stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    assert.equal(stop.status, 200);
    const staticOnState = await fetch(`${host.url}assets/../../../../package.json`);
    assert.equal(staticOnState.status, 404);
    const wrongMethod = await fetch(`${host.url}not-found`);
    assert.equal(wrongMethod.status, 404);
    const invalidJson = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    const oversizedPrompt = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "x".repeat(8_001) }),
    });
    assert.equal(oversizedPrompt.status, 400);
    await reader.cancel();

    const uncertainPrompt = await fetch(`${host.url}prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ message: "process-error" }),
    });
    assert.equal(uncertainPrompt.status, 503);
    assert.deepEqual(await uncertainPrompt.json(), {
      error: "Pi RPC process is unavailable.",
    });
    const unavailableState = await fetch(`${host.url}state`);
    assert.equal(
      unavailableState.status,
      503,
      "uncertain admission must not be retried automatically",
    );
  } finally {
    await host.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stop RPC failures fail closed and never report a successful stop", async () => {
  for (const message of ["fail-clear-queue", "fail-abort"]) {
    const fixture = await createFixture();
    const host = await startPiHost({
      cliPath: fixture.cliPath,
      clientDirectory: fixture.clientDirectory,
      cwd: fixture.root,
    });
    try {
      const prompt = await postJson(host, "prompt", { message });
      assert.equal(prompt.status, 202);

      const stop = await postJson(host, "stop");
      assert.equal(stop.status, 503, `${message} must not report stop success`);
      assert.deepEqual(await stop.json(), { error: "Pi RPC process is unavailable." });

      const state = await fetch(`${host.url}state`);
      assert.equal(state.status, 503, `${message} must make the Pi view unavailable`);
      const retry = await postJson(host, "prompt", { message: "must-not-be-admitted" });
      assert.equal(retry.status, 503, `${message} must close prompt admission immediately`);
      assert.equal(await readFile(join(fixture.root, "prompts.log"), "utf8"), `${message}\n`);
    } finally {
      await host.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a stop for B uses its own flight while A's clear_queue ACK is delayed", async () => {
  const fixture = await createFixture();
  const host = await startPiHost({
    cliPath: fixture.cliPath,
    clientDirectory: fixture.clientDirectory,
    cwd: fixture.root,
  });
  const eventsResponse = await fetch(`${host.url}events`);
  const reader = eventsResponse.body!.getReader();
  try {
    const initial = await readEvent(reader, "");
    assert.equal(initial.event.type, "snapshot");

    assert.equal((await postJson(host, "prompt", { message: "race-A" })).status, 202);
    const stopA = postJson(host, "stop");
    let eventBuffer = initial.remainder;
    let event = await readUntilState(reader, eventBuffer, (state) =>
      state.snapshot.rows.window.some(
        (row: any) => row.kind === "userInput" && row.text === "race-A-clear-queue-received",
      ),
    );
    eventBuffer = event.remainder;
    event = await readUntilState(
      reader,
      eventBuffer,
      (state) => state.phase === "completedSuccess" && state.streaming === false,
    );
    eventBuffer = event.remainder;

    assert.equal((await postJson(host, "prompt", { message: "race-B" })).status, 202);
    const stopB = postJson(host, "stop");
    event = await readUntilState(reader, eventBuffer, (state) =>
      state.snapshot.rows.window.some(
        (row: any) => row.kind === "userInput" && row.text === "race-B-clear-queue-received",
      ),
    );
    const [responseA, responseB] = await Promise.all([stopA, stopB]);
    assert.equal(responseA.status, 200);
    assert.deepEqual(await responseA.json(), { stopped: true, pending: false });
    assert.equal(responseB.status, 200);
    assert.deepEqual(await responseB.json(), { stopped: true, pending: false });
  } finally {
    await reader.cancel();
    await host.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an uncertain prompt ACK times out closed before another prompt can enter", async () => {
  const fixture = await createFixture();
  const host = await startPiHost({
    cliPath: fixture.cliPath,
    clientDirectory: fixture.clientDirectory,
    cwd: fixture.root,
    rpcCommandTimeoutMs: 75,
  });
  try {
    const uncertain = await postJson(host, "prompt", { message: "prompt-no-ack" });
    assert.equal(uncertain.status, 503);
    assert.deepEqual(await uncertain.json(), { error: "Pi RPC process is unavailable." });
    const next = await postJson(host, "prompt", { message: "must-not-be-admitted" });
    assert.equal(next.status, 503);
    assert.deepEqual(await next.json(), { error: "Pi session is unavailable." });
    assert.equal(await readFile(join(fixture.root, "prompts.log"), "utf8"), "prompt-no-ack\n");
    assert.equal((await fetch(`${host.url}state`)).status, 503);
  } finally {
    await host.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
