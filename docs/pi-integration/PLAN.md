# Pi GUI integration plan

Status: **historical initial plan**. The Pi-only browser slice and dual tool modes are now verified; Desktop integration remains unimplemented. See [MASTER-PLAN.md](MASTER-PLAN.md) for the current proposed desktop integration and decision gates. The pending labels below reflect the original plan at the time it was written.

## Goal and boundaries

Make Pi the agent behind a usable desktop GUI while retaining a practical path to ZCode upstream updates. Pi owns agent execution, messages, tools, and durable sessions. ZCode provides a candidate desktop shell and conversation UI; any ZCode projection is derived from Pi state, not a competing source of truth.

Not in the initial product slice: Z.ai account, billing, ZCode Agent runtime, ZCode-specific queue/Goal/workflows/automation, remote control, mobile, sharing, or Grok Build integration. Hide unsupported operations rather than reporting success for no-op service methods. Do not represent ZCode's approval UI as Pi tool approval: Pi does not require approval before every tool call.

## Working architecture

```text
Pi-specific desktop composition (capabilities/navigation)
    -> narrow session UI contract + adapter
    -> Pi RPC process (JSONL events/commands)
    -> Pi session files and runtime (authority)
```

The existing `ConversationTransport` and `SessionDataLayer` are useful candidate seams, but not an entire product boundary: `V4ConversationContext.tsx` constructs a ZCode-specific transport and `SessionPane.tsx` also reads ZCode task/session/model/share services. Choose the actual composition seam after a visible vertical slice; avoid distributing `if (pi)` branches throughout upstream components. Keep custom code in dedicated files/packages where possible, with a small, reviewable set of upstream entrypoint changes.

## Validation gates

1. **Protocol evidence — complete for a narrow single-session path.** Pi RPC can send a read-only prompt and emit message/tool events; experimental Pi→V4 frames validate against ZCode schemas and reach the real `SessionDataLayer`/`ConversationProjectionStore`, including an aborted turn. This uses an in-memory mock transport, not the desktop Host.
2. **Visible vertical slice — pending.** Launch a Pi-specific desktop/web development surface with one workspace and one visible session. Verify send, streamed text, tool result, stop, and honest unsupported states. Record every changed upstream file and whether the session pane can be reused without service shims.
3. **Durability and recovery — pending.** Define stable Pi session identity and process ownership; validate startup/shutdown, session reopen, persisted history, reconnect, missing-frame recovery, and failure paths without fabricating state. Pi's `--no-session` probes do not test this.
4. **Upstream maintenance trial — pending.** Merge an upstream update into the fork without rewriting history, run targeted compatibility checks, and measure conflicts and Pi-specific changes. If core containers/services require widespread ongoing edits, prefer a thinner Pi-owned shell that reuses selected ZCode UI parts.

Only after gates 2–4 should we commit to maintaining a full ZCode-derived application. An experimental projection alone does not establish that cost.

## Integration and safety decisions to resolve

- Fork versus separate Pi-owned shell: start by testing a history-preserving ZCode fork with additive integration; revisit after a real upstream merge. Do not copy/paste the UI or physically delete upstream modules prematurely.
- Process topology: one Pi session per workspace/pane versus a Pi process owning switchable sessions; define lifecycle, cancellation, crash recovery, and session list ownership before persistent integration.
- Model, extension dialogs, permissions/trust, attachments, and rich tool presentation need explicit contracts. Pi RPC extension UI supports basic dialogs but not TUI-only custom components. Capability-gate anything not implemented.
- Packaging and distribution: keep ZCode and third-party license notices; review whether shipped assets, auth endpoints, telemetry, and update behavior remain appropriate for the Pi product shape. Do not assume a browser page or mock transport establishes desktop packaging.

## Reproduction

From the repository root, `node scripts/pi-integration/pi-rpc-smoke.mjs` probes RPC without a model call; add `--live` to invoke the model. To validate ZCode's data layer, run:

```bash
pnpm exec tsx --tsconfig packages/ui/tsconfig.json scripts/pi-integration/pi-v4-smoke.mjs
```

That command makes model calls, reads the local `mise.toml` fixture, and uses ephemeral sessions. The probes currently depend on an installed Pi CLI at the default Windows npm path (override with `PI_CLI_PATH`) and ZCode workspace dependencies. They are development evidence, not a production adapter.
