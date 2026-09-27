#!/usr/bin/env node
// HTTP-level probe. Starts the isolated GUI as a child; never starts ZCode Desktop.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const live = process.argv.includes("--live");
if (process.argv.slice(2).some((arg) => arg !== "--live")) {
  console.error("Usage: node scripts/pi-integration/pi-gui-check.mjs [--live]");
  process.exit(2);
}
const child = spawn(process.execPath, [fileURLToPath(new URL("./pi-gui-server.mjs", import.meta.url))],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
let stderr = "";
let url;
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  const match = output.match(/Pi GUI probe: (http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/)/u);
  if (match) { url = match[1]; readyResolve(); }
});
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
child.on("error", readyResolve);
child.on("close", readyResolve);
const timeout = setTimeout(() => { child.kill(); readyResolve(); }, 12_000);
async function request(path, { method = "GET", origin, body } = {}) {
  const response = await fetch(new URL(path, url), { method, headers: {
    ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, data: type.includes("json") ? await response.json() : await response.text() };
}
try {
  await ready;
  clearTimeout(timeout);
  if (!url) throw new Error(`No server URL: ${stderr || output}`);
  const { origin } = new URL(url);
  let state;
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await request("state");
    if (state.data?.phase === "idle" || state.data?.phase === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (state.status !== 200 || state.data.phase !== "idle" || !state.data.sessionId) throw new Error(`Initial state not ready: ${state.data?.phase}`);
  const page = await request("./");
  if (page.status !== 200 || !page.data.includes("Pi · isolated GUI probe")) throw new Error("Page not served");
  const denied = await request("prompt", { method: "POST", origin: "http://other.invalid", body: { message: "test" } });
  if (denied.status !== 403) throw new Error(`Cross-origin request was not denied: ${denied.status}`);
  const invalid = await request("prompt", { method: "POST", origin, body: { message: "" } });
  if (invalid.status !== 400) throw new Error("Empty prompt accepted");
  const lost = await fetch(origin + "/state");
  if (lost.status !== 404) throw new Error("Unscoped transcript endpoint exposed");
  const deniedBody = await fetch(new URL("prompt", url), { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" });
  if (deniedBody.status !== 403) throw new Error("Wrong content type accepted");
  if (live) {
    const post = await request("prompt", { method: "POST", origin, body: { message: "Use the read tool to inspect mise.toml and answer only the pinned Node version. Do not modify anything." } });
    if (post.status !== 202 || !post.data.accepted) throw new Error(`Prompt not accepted: ${post.status}`);
    let final;
    for (let attempt = 0; attempt < 120; attempt++) {
      final = (await request("state")).data;
      if (final.phase === "error" || !final.streaming) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (final.phase !== "idle" || !final.transcript.some((item) => item.role === "assistant" && item.text.includes("24.14.0"))) {
      throw new Error(`Live turn failed: ${final.phase} ${stderr.slice(-100)}`);
    }
    console.log("PASS: Pi read-only live prompt, one admitted turn, settled transcript");
    const slow = await request("prompt", { method: "POST", origin, body: { message: "Read mise.toml once. Then write a very detailed explanation of Node and pnpm version pinning with at least 1000 words. Do not edit files." } });
    if (slow.status !== 202) throw new Error(`Abort turn not accepted: ${slow.status}`);
    const stopResult = await request("stop", { method: "POST", origin, body: {} });
    if (stopResult.status !== 200) throw new Error(`Stop failed: ${stopResult.status}`);
    let stopped;
    for (let attempt = 0; attempt < 120; attempt++) {
      stopped = (await request("state")).data;
      if (stopped.phase === "error" || !stopped.streaming) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (stopped.streaming || stopped.phase === "error") throw new Error(`Stop did not settle: ${stopped.phase}`);
    console.log(`PASS: Pi stop settled (phase=${stopped.phase}; quick completion may precede stop)`);
  }
  console.log("PASS: loopback page/state, capability path, origin and body checks");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
  await Promise.race([once(child, "close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2500))]);
}
