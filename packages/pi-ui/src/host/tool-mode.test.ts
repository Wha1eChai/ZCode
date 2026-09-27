import assert from "node:assert/strict";
import test from "node:test";
import { parseToolModeArgs } from "./tool-mode.js";

test("Pi UI host arguments default to read-only and accept explicit modes", () => {
  assert.equal(parseToolModeArgs([]), "read-only");
  assert.equal(parseToolModeArgs(["--tool-mode", "read-only"]), "read-only");
  assert.equal(parseToolModeArgs(["--tool-mode", "full"]), "full");
});

test("Pi UI host rejects unknown, incomplete, and extra command-line arguments", () => {
  for (const args of [
    ["--unknown"],
    ["--tool-mode"],
    ["--tool-mode", "sandbox"],
    ["--tool-mode", "full", "--unknown"],
    ["--tool-mode=full"],
  ]) {
    assert.throws(() => parseToolModeArgs(args), /Pi UI host arguments|Unknown Pi tool mode/);
  }
});
