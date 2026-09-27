# TypeScript Pi-only presentation slice

Status: implemented and locally validated as a Pi-only TS/TSX vertical slice (not Desktop integration or a released product). The existing `.mjs` probes remain test tools; they are not the Pi GUI runtime.

## Scope and ownership

A new `packages/pi-ui` package owns a Pi RPC child and a loopback-only browser surface. The browser is built from TSX using the same React/Tailwind/ZCode UI components as the Web renderer, but does not import `packages/web/src/main.tsx`, `packages/server/src/node.ts`, ZCode Desktop Main/Host, or task/session services. Pi alone owns session transcript, tool execution and model state; any V4 rows are derived presentation data. This is a local read-only, single-session experiment, not a release.

```text
Pi-only Node TS owner -> Pi RPC child (ephemeral/read-only/no discovered extensions)
                 | -> authenticated loopback HTTP events/commands
                 v
Pi-only TSX app -> derived V4 rows -> ZCode ConversationTimeline
```

Use a random capability-scoped path, bind `127.0.0.1` only, reject wrong Host/Origin/unsafe content types and cap payloads. Display the capability URL only in the local host terminal so the user can open it; do not emit it in HTTP logs, external origins or third-party resources. Anyone with the local URL can submit prompts and read the ephemeral conversation. The Pi child has read-only tools, but these tools are not filesystem-sandboxed: a prompt could read any file available to that OS account. This is a local capability experiment, not OS isolation or a production security boundary. Errors are bounded and never include raw stderr, prompt bodies or credentials.

## Contract and event order

Host and browser share a narrow JSON contract under the capability-scoped path. `ViewState = { sessionId, model, phase, streaming, snapshot, generation }`, where `snapshot` is a ZCode `ConversationSnapshot` derived from Pi events and `generation` is monotonically increased on each projection change. SSE emits `{ type: "snapshot", state: ViewState }`; a reconnect refetches `/state` and atomically replaces the view. There is no cursor/resume promise for this slice. Snapshot size and row history must be bounded without silently claiming durable history.

- `GET /state`: current Pi session ID, model, phase, and complete current derived view snapshot (or a bounded resync view for this one session). Subscribe before prompting; refresh/resubscribe gets a full snapshot. No durable history or fabricated resume cursor.
- `POST /prompt`: one active prompt at a time; reserve local admission synchronously. ACK means Pi accepted the prompt, **not** settled. Distinguish rejection from model/turn failure; client must never optimistically claim work succeeded. Handle `agent_settled` preceding ACK.
- `POST /stop`: if admitting, defer stop until acceptance; otherwise `clearQueue()` then `abort()` while active. Stop after idle is harmless; no second queue/drainer. Stop flights are bound to the active admission; an earlier turn's delayed ACK cannot consume or erase a later turn's stop. If stop RPC fails or prompt ACK is uncertain, make the child unavailable immediately, terminate it and reject further prompts rather than claim a successful stop or retry uncertain work.
- Server owns Pi RPC process lifecycle. Child exit makes current view unavailable; do not automatically retry an uncertain accepted prompt. Server shutdown closes Pi cleanly with bounded fallback. Serve only built static assets from the scoped path; never expose a filesystem browsing route or raw RPC stderr. The public package API/renderer entry should not import ZCode services or Desktop Main.
- V4 projection records ordered user/assistant/tool lifecycle. `message_end` is authoritative for the final assistant content; `agent_settled` closes automatic retry/follow-up. Unsupported actions (share/goal/queue/model picker/permissions/attachments) are absent, not fake-success stubs.

## Acceptance

- Built Pi-only entrypoint serves a styled `ConversationTimeline` at desktop and narrow viewport; browser sends a read-only request and observes text/tool/stop. No ZCode Host/Agent, cron or account services start in idle process observation.
- Unit/integration checks cover Pi RPC ACK-vs-settled, stop during admission, duplicate/incomplete stream and resync-on-refresh; HTTP checks cover access controls. A browser screenshot alone is not functional evidence.
- Record exact upstream-file touch count and bundle size. If mounting `ConversationTimeline` requires broad service shims or runtime side effects, switch to smaller rendering leaves or abandon reuse for this slice.
- Run focused checks, architecture check, lint, typecheck; report environment-blocked checks accurately. Do not assert a working Desktop app or persistence.

## Local validation (2026-09-27)

From the repository root: `pnpm --dir packages/pi-ui build`, 10 targeted Node tests in `src/host/{projection,server,post-routes}.test.ts` and `src/client/api.test.ts` (including stop-RPC failure, delayed cross-turn ACK and uncertain prompt ACK), root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, and `node scripts/check-workspace-freshness.mjs` passed. Lint reported 70 existing warnings and zero errors. A real Pi RPC child in an ephemeral session handled a browser read-tool prompt, streamed the final answer, and stopped a second turn; a refresh displayed the current bounded snapshot. At 390 px the browser had no horizontal overflow. Expanding the tool row loaded a scoped TOML icon (HTTP 200), while an unscoped icon returned 404. The browser reported no JS errors or failed requests in this check. The host and its child exited after verification.

The build produces approximately 29.7 MB across 1,930 files (1,146 SVG material icons); the primary JS chunk is about 3.15 MB minified and Vite warns about chunks over 500 kB. This is a performance limitation, not a production-ready bundle. No ZCode Desktop or ZCode Agent was started; no persisted-session recovery or full security audit is claimed. Runtime Node was v24.11.1 versus the pinned v24.14.0.

Upstream-tracked existing files changed: **2** (`packages/ui/package.json` for the narrow public export and `pnpm-lock.yaml` for the new workspace package). A **new** `packages/ui/src/v4/PiConversationTimeline.tsx` entry re-exports presentation leaves; all other implementation lives in the new `packages/pi-ui/` package. No existing upstream TSX implementation was changed.
