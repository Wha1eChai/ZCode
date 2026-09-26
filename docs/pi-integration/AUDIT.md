# Thin-harness boundary audit (static, 2026-09-27)

Scope: source inspection by five independent read-only lanes. No ZCode application/network trace was run. This is a decision aid, not evidence that the Pi product shape already works.

## Decision

Treat Pi as the **only** agent/session/tool execution authority. Reuse ZCode presentation selectively. Do not assume the existing Desktop `Main -> Local Host -> createLocalServices -> ZCode Agent` chain is a thin, inert shell. For the first visible slice, test a Pi-owned composition/entrypoint before adapting the whole ZCode Host. Revisit this choice after measuring actual code changes and startup side effects.

| Surface | Preliminary disposition | Reason / evidence |
| --- | --- | --- |
| ZCode V4 projection + conversation rendering | Reuse selectively | `packages/ui/src/v4/sessionDataLayer.ts`, `conversationProjectionStore.ts`; live Pi frames passed a mock-transport probe. This does not verify a visible UI. |
| ZCode `SessionPane`, Root/sidebar and broad `ConversationTransport` | Split or capability-gate after a vertical slice | `packages/ui/src/v4/SessionPane.tsx` reads ZCode task/session/model/share services; `V4ConversationContext.tsx` constructs the ZCode transport directly; `transport.ts` includes far more than chat. Avoid no-op service stubs. |
| ZCode Agent runtime, ZCode queue, session store, model selection, permission broker | Do not run as competing owners | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`; Pi RPC has separate session/model/abort/queue semantics (`docs/rpc-commands.md` in installed Pi). Do not map Pi project trust or extension dialogs to general tool approval. |
| Existing ZCode Desktop startup | Isolate; do not merely remove warmup targets | `packages/desktop/src/main/index.ts:1958-1975`, `packages/desktop/src/host/index.ts:2819-2933`, `packages/services/src/node.ts:2639-2651`: scheduler, storage/Host initialization, provider runtime and conditional Agent warmup have real startup paths. |
| Z.ai account, telemetry, updater, remote provisioning, OS integrations | Disabled in Pi-only shape pending runtime proof | `packages/services/src/telemetry/telemetryCore.ts:321-425`, `packages/desktop/src/main/desktopRemoteSessions.ts:401-419`, `packages/ui/src/root/useRootOAuthEffects.ts:128-187`. Conditional effects are not all unconditional requests. Remote provisioning can sync credential material **only after connection**; telemetry may carry authorization when configured; prompt-template selection records prompt content (`packages/ui/src/lib/promptTemplateTelemetry.ts:8-25`). |
| Pi extensions / packages | Start isolated; allowlist after audit | `--no-extensions` disables discovered/configured extensions but explicit `-e` still loads. `--tools` limits tools, not lifecycle handlers. `--no-context-files` disables AGENTS/CLAUDE context, not an OS sandbox. RPC custom terminal UI is unavailable; basic extension dialogs are supported (installed Pi `docs/cli.md`, `docs/rpc-extension-ui.md`, `docs/security.md`). |

Local extension directory contains six top-level `.ts` files; current user settings declare 15 packages. This inventory did **not** audit the package-provided extensions. TUI display/footer enhancements can be omitted in Pi RPC; Orca-related status forwarding needs separate privacy/receiver review before enabling. Do not copy local extension settings or credentials into the public fork.

## First runtime audit gates

1. Start an isolated Pi-only GUI entrypoint with extensions disabled, one workspace and one session; verify ZCode Agent, cron scheduler, Z.ai provider refresh and remote provisioning are not started. Observe process tree and network destinations without logging tokens or session bodies.
2. Verify visible send -> text/tool stream -> stop against Pi RPC, including real UI command ACKs. Keep Pi's session ID and transcript authoritative; no ZCode task database fallback.
3. Re-enable required Pi resources one at a time, testing `ctx.mode === "rpc"` behavior and extension UI dialogs. Explicitly review package-provided extensions, not only files in the local extensions folder.
4. Before claiming persistence or thin-harness status, test crash/restart, session reopen, queued input + stop, and missing-frame recovery. The current `--no-session` probe cannot cover these.

Record every upstream file touched by the vertical slice. If avoiding the ZCode Host requires extensive Root/SessionPane/service shims, favor a smaller Pi-owned shell that imports selected ZCode UI rather than imitating its product services.
