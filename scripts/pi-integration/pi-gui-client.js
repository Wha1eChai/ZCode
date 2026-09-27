const messages = document.getElementById("messages");
const status = document.getElementById("status");
const prompt = document.getElementById("prompt");
const send = document.getElementById("send");
const stop = document.getElementById("stop");
let partial = null;
let busy = false;
let submitting = false;
let phase = "starting";
function add(role, text) {
  const item = document.createElement("div");
  item.className = `message ${role}`;
  item.textContent = text;
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}
function state(nextPhase, streaming) {
  phase = nextPhase;
  busy = streaming;
  status.textContent = nextPhase;
  send.disabled = submitting || busy || phase === "starting" || phase === "error";
  stop.disabled = !busy;
}
function reset(snapshot) {
  messages.replaceChildren();
  for (const item of snapshot.transcript) add(item.role, item.text);
  if (snapshot.partial) partial = add("assistant", snapshot.partial);
  state(snapshot.phase, snapshot.streaming);
}
async function load() {
  const response = await fetch("state", { cache: "no-store" });
  if (!response.ok) throw new Error("State request failed");
  reset(await response.json());
}
load().catch((error) => { state("error", false); add("error", error.message); });
const events = new EventSource("events");
events.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case "text":
      if (!partial) partial = add("assistant", "");
      partial.textContent += data.delta;
      messages.scrollTop = messages.scrollHeight;
      break;
    case "message":
      if (data.role === "user") add("user", data.text);
      else {
        if (partial) partial.textContent = data.text;
        else if (data.text) add("assistant", data.text);
        partial = null;
      }
      break;
    case "tool":
      add("tool", `${data.name}: ${data.status}`);
      break;
    case "state": state(data.phase, data.streaming); break;
    case "error": add("error", data.message); break;
  }
};
events.onerror = () => { status.textContent = "Connection lost — refresh to inspect current state"; };
document.getElementById("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || submitting || !prompt.value.trim()) return;
  const message = prompt.value;
  submitting = true;
  send.disabled = true;
  try {
    const response = await fetch("prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    if (!response.ok) throw new Error((await response.json()).error || "Prompt failed");
    prompt.value = "";
  } catch (error) { add("error", error.message); }
  finally { submitting = false; state(phase, busy); }
});
stop.addEventListener("click", async () => {
  stop.disabled = true;
  try {
    const response = await fetch("stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error((await response.json()).error || "Stop failed");
  } catch (error) { add("error", error.message); stop.disabled = false; }
});
