import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { PiV4Projection } from "./projection.js";

test("Pi projection shows built-in tool lifecycle and replaces bounded partial output", () => {
  const projection = new PiV4Projection("tool-output-session", { provider: "local", id: "test" });
  projection.observe({ type: "agent_start" });

  for (const toolName of ["bash", "edit", "write"]) {
    const id = `call-${toolName}`;
    projection.observe({
      type: "tool_execution_start",
      toolCallId: id,
      toolName,
      args: { path: "safe.txt" },
    });
    const started = projection.snapshot.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === id,
    );
    assert.equal(started?.kind, "toolCall");
    if (started?.kind === "toolCall") assert.equal(started.status, "running");

    if (toolName === "bash") {
      projection.observe({
        type: "tool_execution_update",
        toolCallId: id,
        toolName,
        partialResult: { content: [{ type: "text", text: "x".repeat(40_000) }] },
      });
      let updated = projection.snapshot.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolCallId === id,
      );
      assert.equal(updated?.kind, "toolCall");
      if (updated?.kind === "toolCall") assert.equal(updated.output?.text.length, 32_000);

      projection.observe({
        type: "tool_execution_update",
        toolCallId: id,
        toolName,
        partialResult: { content: [{ type: "text", text: "replacement output" }] },
      });
      updated = projection.snapshot.rows.window.find(
        (row) => row.kind === "toolCall" && row.toolCallId === id,
      );
      assert.equal(updated?.kind, "toolCall");
      if (updated?.kind === "toolCall") assert.equal(updated.output?.text, "replacement output");
    }

    projection.observe({
      type: "tool_execution_end",
      toolCallId: id,
      toolName,
      result: { content: [{ type: "text", text: `authoritative ${toolName} result` }] },
      isError: false,
    });
    const ended = projection.snapshot.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === id,
    );
    assert.equal(ended?.kind, "toolCall");
    if (ended?.kind === "toolCall") {
      assert.equal(ended.status, "success");
      assert.equal(ended.output?.text, `authoritative ${toolName} result`);
    }

    projection.observe({
      type: "tool_execution_update",
      toolCallId: id,
      toolName,
      partialResult: {
        content: [{ type: "text", text: "late update must not replace the final result" }],
      },
    });
    const final = projection.snapshot.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === id,
    );
    assert.equal(final?.kind, "toolCall");
    if (final?.kind === "toolCall")
      assert.equal(final.output?.text, `authoritative ${toolName} result`);
  }

  assert.equal(conversationSnapshotSchema.safeParse(projection.snapshot).success, true);
});

test("Pi projection trusts message_end and agent_settled, tolerating duplicate/incomplete tool streams", () => {
  const changes: number[] = [];
  const projection = new PiV4Projection(
    "ephemeral-session",
    { provider: "local", id: "test-model" },
    (snapshot) => {
      changes.push(snapshot.seq);
    },
  );

  projection.setRunState("running", true);
  projection.observe({ type: "agent_start" });
  projection.observe({ type: "message_start", message: { role: "user", content: "hello" } });
  projection.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "draft text" },
  });
  projection.observe({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "authoritative answer" }],
      stopReason: "stop",
    },
  });
  projection.observe({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    args: {},
    result: { content: [{ type: "text", text: "tool result" }] },
    isError: false,
  });
  projection.observe({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "x" },
  });
  projection.observe({
    type: "tool_execution_start",
    toolCallId: "tool-2",
    toolName: "grep",
    args: {},
  });
  projection.observe({ type: "agent_end" });

  assert.equal(projection.snapshot.control.phase, "running", "agent_end is not a terminal event");
  assert.equal(
    projection.snapshot.rows.window.filter(
      (row) => row.kind === "toolCall" && row.toolCallId === "tool-1",
    ).length,
    1,
  );
  const completedTool = projection.snapshot.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolCallId === "tool-1",
  );
  assert.equal(completedTool?.kind, "toolCall");
  if (completedTool?.kind === "toolCall") assert.equal(completedTool.status, "success");

  const settled = projection.observe({ type: "agent_settled" });
  assert.deepEqual(settled, { terminal: "idle" });
  assert.equal(projection.snapshot.control.phase, "completedSuccess");
  const assistant = projection.snapshot.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(assistant?.kind, "assistantText");
  if (assistant?.kind === "assistantText") {
    assert.equal(assistant.text, "authoritative answer");
    assert.equal(assistant.state, "complete");
  }
  const incompleteTool = projection.snapshot.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolCallId === "tool-2",
  );
  assert.equal(incompleteTool?.kind, "toolCall");
  if (incompleteTool?.kind === "toolCall") assert.equal(incompleteTool.status, "error");
  assert.ok(changes.length > 0);
  assert.deepEqual(
    changes,
    [...changes].sort((left, right) => left - right),
  );
  assert.equal(conversationSnapshotSchema.safeParse(projection.snapshot).success, true);
});
