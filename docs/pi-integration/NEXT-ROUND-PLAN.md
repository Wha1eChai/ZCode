# Next round: test ZCode presentation reuse with the Pi-only host

Status: **historical presentation-reuse plan, completed for the Pi-only TS slice**. [TS-SLICE.md](TS-SLICE.md) records its actual result; [MASTER-PLAN.md](MASTER-PLAN.md) is the current proposed Desktop integration plan. The checks and pending prerequisites below describe the earlier round, not the current checkout.

Implementation correction: use ZCode’s TypeScript/React app and build conventions for the integration. Keep `.mjs` only for bounded command-line probes; do not extend the standalone `.mjs` HTTP test server into a product entrypoint. The temporary render fixture showed `ConversationTimeline` can mount with intl and tooltip providers, but the isolated runtime page bypassed normal app styling and is not suitable as the implementation. Recheck this seam through an in-project TS/TSX entrypoint.

## Decision to make

Can a Pi-specific **TypeScript/React entrypoint in the ZCode build** drive ZCode's actual conversation presentation without starting the existing ZCode Host/Agent or emulating its task, account, model and share services? Keep `scripts/pi-integration/pi-gui-server.mjs` only as earlier protocol/HTTP evidence. Compare:

- **A — existing V4 timeline:** use `SessionDataLayer` / `ConversationProjectionStore` and `ConversationTimeline` with a Pi-owned outer shell and composer.
- **B — smaller presentation leaves:** use selected message/tool components if importing `ConversationTimeline` requires broad service providers or unrelated side effects.
- **C — keep a Pi-owned UI:** retain the isolated page temporarily if both ZCode reuse paths require substantial edits to upstream containers or fake services.

Prefer A only if its _running_ import and interaction path remains narrow. Schema compatibility from `pi-v4-smoke.mjs` does not establish that A can render safely. Do not adapt all of `SessionPane` merely to avoid choosing B or C: it reads ZCode task/session/model/share services (`packages/ui/src/v4/SessionPane.tsx`).

## Invariants and scope

```text
ZCode-built Pi-only TS/TSX entrypoint (draft and presentation)
    -> explicitly owned Pi process/transport boundary
    -> Pi RPC (messages, model, tools, stop, session authority)
    -> Pi event projection -> ZCode V4 view state (derived, disposable)
```

- Keep one Pi process/session, one local workspace, loopback-only access and the existing restricted tool set. Keep `--no-session` and disabled extensions for this round. No ZCode Desktop `Main -> Local Host -> createLocalServices`, ZCode task DB, cron, account, updater or remote provisioning in the Pi-only path.
- A Pi `prompt` ACK means accepted, **not** completed. Pi `agent_settled` closes the run; `clear_queue` before `abort` preserves the tested stop semantics. Pi remains the source of truth if projection and UI disagree.
- No ZCode permission prompt implying Pi tool approval. No hidden buttons that send unsupported V4 commands; model picker, sharing, Goal, queue, file rewind, attachments, Pi extension dialogs and durable sessions stay outside this slice.
- Keep production-candidate Pi integration in an isolated TS/TSX entrypoint/package that uses ZCode's normal bundling and styling conventions. Reserve `scripts/pi-integration/*.mjs` for probes. Modify upstream files only when a small explicit entrypoint/export is unavoidable; record every such file. Do not introduce no-op `IZCodeTaskService`/`IZCodeSessionService` substitutes.
- The existing `pi-gui-server.mjs` remains a browser experiment, not the runtime for the TS/TSX entrypoint. Define its process owner and local transport explicitly; do not weaken loopback/path/Origin security if an HTTP boundary is selected.

## Work sequence and acceptance evidence

### 1. Map the render boundary before changing it

Trace `ConversationTimeline` and its row renderer imports, contexts and required props. Run a **render-only fixture through the normal ZCode UI build/styling path** with V4 rows already produced by `pi-v4-projection.mjs`; determine which providers are genuinely required and whether importing the component constructs services, registers telemetry or launches background work. Use `packages/ui/src/v4/ConversationTimeline.tsx`, `ConversationRowView.tsx`, `conversationRowContext.ts`, `V4ConversationContext.tsx` and `SessionPane.tsx` as starting points. Classify each dependency as required for chat, optional with a disabled action, or an unacceptable ZCode product dependency.

**Gate:** record a compact dependency map and a justified A/B/C candidate. A source import tree alone is not runtime side-effect evidence. If A depends on service shims or ZCode startup, try B; do not patch the full application to force A.

### 2. Connect a real, narrow live data path

Use Pi RPC session events to update the V4 view projection and feed the selected ZCode presentation from the TS/TSX Pi-owned entrypoint and its explicit process/transport owner. Preserve ordered text/tool/stop states and `message_end` authority. Reuse the existing schema and data-layer regression probe; do not duplicate an independently writable transcript in ZCode. If the real `SessionDataLayer` is used, implement the minimum honest `ConversationTransport` subscription/snapshot/contiguous-delta behavior required for this one live session, including a full-snapshot fallback on missed events rather than fabricated resume support. Explicitly fail unsupported transport methods instead of returning plausible empty data.

**Gate:** in the ZCode-built Pi-only UI, one submitted read-only turn visibly shows the user input, streamed answer and tool lifecycle; stop settles without a second run; page refresh shows only the in-memory snapshot and is labeled non-durable. Verify an accepted prompt that settles before its ACK and a stop requested during admission. Record failures and event order; do not rely solely on a final transcript screenshot.

### 3. Verify isolation and presentation, then choose

Run the existing HTTP/security and Pi RPC/V4 probes as regression evidence, plus targeted checks for the new TS/TSX entrypoint and the relevant architecture/lint/type checks. Inspect the rendered page at a desktop and narrow viewport, including long text, error and active stop states. Capture a bounded process/network observation for the **new** entrypoint: attribute the listener and child process; distinguish idle from a model turn and do not log credentials, prompts or raw session bodies. A standalone Pi-only page does **not** prove the normal ZCode Desktop startup is inert.

List changed upstream files and the independent Pi-owned files in `HISTORY.csv`. Compare A/B/C by (1) actual UI reuse, (2) upstream edit footprint and coupling, (3) startup side effects, (4) unsupported-control clarity, and (5) focused verification results. Choose the smallest maintainable boundary; if uncertain, preserve the isolated experiment and state the missing evidence rather than integrating into Desktop prematurely.

## Checks and known prerequisites

From the repository root:

```bash
node scripts/check-workspace-freshness.mjs
node scripts/pi-integration/pi-gui-check.mjs --live
pnpm exec tsx --tsconfig packages/ui/tsconfig.json scripts/pi-integration/pi-v4-smoke.mjs
pnpm architecture:check --changed
pnpm lint
pnpm typecheck
```

The existing full `pnpm typecheck` currently fails after filtered dependency installation (`TS2307: Cannot find module '@zcode/rpc'`, among others). Before treating a new typecheck failure as a regression, restore the repository's pinned Node 24.14.0/pnpm 10.33.2 toolchain and complete the documented bootstrap; preserve and report the exact remaining output. Browser-rendered inspection and HTTP assertions are separate evidence. Live tests call the configured model and may incur cost.

## Not part of this round

No ZCode Desktop fork wiring, plugin/package re-enablement, durable Pi session listing, remote control, publishing, production build, or upstream merge. These become separate decisions after a real presentation reuse result. Update `PROGRESS.csv` and append a short `HISTORY.csv` row only for work actually performed.
