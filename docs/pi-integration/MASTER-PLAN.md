# Pi as the agent behind a ZCode-derived desktop GUI

Status: **proposed integration plan**, not approval to replace the existing ZCode runtime or evidence of a working Electron app. Baseline: fork `main` at `a2f9716` (2026-09-27); recheck the checkout, Pi version, and upstream ref before executing a phase. This plan supersedes the implementation status in [PLAN.md](PLAN.md) and [NEXT-ROUND-PLAN.md](NEXT-ROUND-PLAN.md); those files remain records of earlier decisions.

## Decision and product boundary

**Recommended route A: a Pi-owned Desktop composition that reuses selected ZCode UI.** Pi is the sole authority for agent execution, tools, model, session files, cancellation, and transcript. The desktop owns windows, navigation, drafts, and a disposable Pi-to-ZCode V4 presentation projection. Reuse the real `ConversationTimeline` and suitable presentation leaves; do **not** launch ZCode Agent beside Pi, map a Pi session to a ZCode task, or implement plausible-looking no-op ZCode services. Keep Pi-specific code additive and upstream merges ordinary (no history rewriting).

Route B—replace ZCode Agent behind the existing Desktop Host/`SessionPane`—is **not** the implementation default. The normal Main → Local Host → `createLocalServices()` path initializes databases, provider/account services and scheduling; `ZCodeAgentProcessManager` expects `app-server --stdio` with ZCode Protocol, not Pi RPC. `SessionPane` directly reads ZCode task/session/model/share services. Merely swapping the executable leaves conflicting owners and misleading controls. Consider B only after an isolated spike proves a single owner and a complete, honest service/transport contract without widespread changes. If B cannot pass that gate, stop the spike rather than accumulating `if (pi)` branches.

| State/action                                   | Authority                                            | Desktop/UI responsibility                                                             |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Transcript, tool outcomes, model, session tree | Pi RPC + Pi session file                             | Render bounded derived rows; never maintain a second writable transcript              |
| Prompt admission, queue, stop, ACK uncertainty | One Pi process owner in the Pi Host                  | Send commands and show accepted/running/unknown/settled states; no optimistic success |
| Workspace ↔ Pi session binding                 | Pi Host-owned private metadata                       | Select a workspace/session; never reuse ZCode task IDs                                |
| Navigation, draft and layout                   | Pi-specific UI composition                           | Discardable UI state; no hidden ZCode task store                                      |
| Permissions/tool mode                          | Pi startup tool allowlist and OS account permissions | Show the actual mode; no fake per-tool approval or workspace sandbox claim            |

The current `packages/pi-ui` TS host, Vite client, and `@zcode/ui/pi-conversation-timeline` export prove one **ephemeral** browser session with real Pi text/read/write/stop; they are not Desktop startup, persistent recovery, or a distribution package. Default GUI tools are `read,grep,find,ls`; explicit `--tool-mode full` adds `bash,edit,write`. Both keep `--no-session` and discovered extensions disabled. `--no-approve` controls project resource trust, not each tool call. The user chose no OS sandbox for this trusted-local product direction; document that a URL holder can request actions with the OS account's permissions.

## System topology to validate

```text
Pi-specific Electron Main (window/process owner, no normal ZCode Main bootstrap)
   ├─ Pi Host process / narrow local IPC or capability-scoped loopback boundary
   │     └─ one Pi RPC child for the selected session (execution + session file)
   └─ Pi-specific renderer composition
         └─ ZCode ConversationTimeline + Pi-only navigation/composer
```

The Pi Host owns one child, workspace/session binding, exact tool-mode startup flags, HTTP/RPC admission, and failure handling. A renderer must never send raw Pi RPC commands such as `bash`, choose a higher tool mode by HTTP, or import ZCode Agent services. Retain a full-snapshot reconnect path until a tested replay protocol exists. A Desktop renderer may reuse the existing loopback boundary during the spike; switching to a typed IPC transport is a separate decision requiring equivalent Origin/capability and event-order guarantees. Do not introduce both transports as permanent independent state owners.

## Work packages and gates

### 0. Make the existing boundary verifiable

- Register `packages/pi-ui` in the project architecture policy or add an explicit import-boundary check: `architecture:check --changed` currently scans managed modules and does **not** establish Pi package isolation. Add `packages/pi-ui` to the root TypeScript build/check or require its own typecheck in the relevant verification path; keep its targeted Node tests first-class.
- Inspect current Pi package dependencies, privacy of generated files, and the renderer export surface. No credentials, Pi session JSONL, capability URLs, raw logs or test transcripts belong in this public fork.
- Acceptance: an import regression from `packages/pi-ui` into ZCode Agent/task/session services fails a check; package typecheck, targeted tests, build, root typecheck/lint, and architecture checks have recorded output. Existing `npm`/`pnpm` and Node versions must be reported, not assumed pinned.

### 1. Desktop isolation spike — one ephemeral session

- Add a **separate Pi-specific Electron Main/window composition** that mounts the existing Pi renderer and owns the Pi Host lifecycle. Do not enter `packages/desktop/src/main/index.ts`'s normal bootstrap or `packages/desktop/src/host/index.ts`. Confirm how the production Electron build starts a Node-capable Pi Host: `process.execPath` in packaged Electron is not automatically equivalent to the development Node binary. Do not rely on a globally installed Windows Pi CLI for a portable product.
- Keep this first desktop spike ephemeral; the same default read-only and explicit full modes, loopback/IPC access rules, CSP, and no hidden ZCode service shims apply. Distinguish an Electron development run from a packaged binary.
- Acceptance: desktop window sends a prompt, renders streaming text and a tool row, and stops a turn. Observe the **actual** process tree and startup/idle network endpoints: no ZCode Host, ZCode Agent, cron scheduler, updater, Z.ai account/OAuth, or ZCode telemetry started by the Pi path. Attribute any endpoint rather than treating all traffic as a failure. Host/window shutdown leaves no owned child. Include startup error, disconnect, stop-during-admission, and narrow-window checks. A browser-only screenshot is not this gate.
- **Stop condition:** if achieving isolation requires mounting normal ZCode `Root`/`SessionPane`, implementing fake task/session/account services, or modifying several shared runtime owners, retain the independent Pi shell and reuse smaller UI leaves instead.

### 2. One-workspace, one-session durability — independent of Electron packaging

- Keep the current ephemeral default until persistence is an explicit user choice with storage/retention rules. In a separate persistent mode, store a **private** workspace binding (canonical workspace identity/cwd, Pi session ID, exact session file/dir, and relevant version/tool-mode metadata). Pi JSONL remains the only transcript authority; Host metadata is a pointer, not a second transcript. Prevent concurrent Host owners of the same binding.
- First creation and reopen must use deterministic identity. Before `--session <absolute file>`, check the recorded file; Pi 0.87.1 can create a new session when the requested path is absent. Check `get_state` session ID/path after opening. Read `get_entries` and its `leafId` to rebuild the active branch, not every abandoned branch in append order; a missing cursor calls for full resync. Do not simply assign `get_messages` to V4 rows or treat an empty recovered session as proof nothing executed.
- Restore the visible bounded projection with explicit incomplete/interrupted tool states. A prompt ACK is admission, `message_end` is final content, and `agent_settled` closes automatic work. On uncertain ACK or crash, fail closed and **never** auto-replay a prompt or a potentially side-effecting tool. An absent entry does not prove an accepted request had no external effects. Do not promise exactly-once, fsync durability, or recovery of an in-flight model call.
- Acceptance with synthetic/private test storage: create → close → reopen exact Pi session and active-branch history; another newer session must not be chosen. Missing/empty/corrupt/mismatched files, cursor errors, two owners, stop races, and crash after a tool side effect produce explicit unavailable/unknown states, not silent new sessions or fabricated success. No private sessions or logs in fixtures. Keep single-session scope; a session picker is a later work package.

### 3. Compose real Pi capabilities without inheriting ZCode task semantics

- Add Pi-owned navigation for workspace/session selection only after phase 2 has a truthful identity and recovery contract. Pi RPC has no `list_sessions` command; if a list is needed, design a private Host index or use Pi's session SDK behind the process boundary, without treating ZCode tasks-index as Pi sessions. Define selection/creation and stale-event fencing before allowing multiple active sessions.
- Show Pi's current model and modes; add model selection only against Pi `get_available_models`/`set_model` with a real failure state. Keep unsupported ZCode queue, share, Goal, approval, retry/edit/fork, remote control and attachments absent. Pi extension UI is a separate audited capability: current Host cancels requests and fails closed; do not silently surface ZCode approval dialogs as Pi permissions.
- Acceptance: A and B sessions have independent identities/transcripts; switching while a prompt runs cannot route Stop or an SSE event to the wrong session. Reopen the selected persisted session without changing A. Visible controls have tested Pi commands and real capability gates. Normal/Desktop and mobile replay semantics are not claimed until implemented.

### 4. Package and maintain, then decide on wider ZCode replacement

- Audit packaging of the Pi CLI, runtime Node/Electron process strategy, supported Windows/macOS/Linux architectures, notices and third-party licenses; current `packages/pi-ui/vite.config.ts` does not use Web's notices plugin, inventory hashes are stale, and `@zcode/pi-ui` assumes a locally installed Pi CLI. Address these **before release**, not by shipping development paths or credentials. The ~29.7 MB build and ~4.47 MB raw first-load static JS graph are performance baselines, not compressed-transfer measurements.
- When `upstream/main` actually advances, check remote SHA/freshness, use `git merge-tree` as a non-destructive conflict estimate, then trial an ordinary merge in an isolated checkout. Record conflicts in `AGENTS.md`, `packages/ui/package.json`, `pnpm-lock.yaml`, any Desktop entrypoint, and compile-time/behavioral drift even without textual conflicts. Current cached upstream is already an ancestor; an empty dry run is not a merge-maintenance trial.
- Acceptance: relevant target-platform development and packaged-app startup checks, Pi child path/lifecycle, notices and strict license check, frozen lockfile, focused tests and root/package checks, process/network audit, and a real incoming-upstream merge trial. No automatic production deployment or release.
- **Re-evaluate route B only if** users require broad existing ZCode `Root`/task functionality and a bounded spike can remove—not duplicate—the ZCode Agent/session owners. Otherwise finish route A as a Pi-owned desktop that borrows ZCode UI; do not confuse “looks like ZCode” with replacing its internal protocol safely.

## Sequencing and accountability

Run packages 0 and the **read-only** portions of 1/2 in parallel with separate file ownership; one writer owns each shared entrypoint. Desktop isolation (1) and durable session recovery (2) can be developed behind their own acceptance gates and integrated only after both contracts pass. Session navigation (3) depends on recovery; packaging/merge evidence (4) depends on the chosen desktop topology. The parent owns architecture, cross-lane integration, diff review and final acceptance; independent Luna agents can inspect Desktop startup, Pi session recovery, UI contracts, and release/merge risk without overlapping writes. Do not mechanically escalate a failed implementation into another broad wave: triage the concrete failure first.

Before any **runtime implementation**, confirm the target product is the recommended Pi-owned desktop composition rather than a requirement to retain ZCode's full task/account/root experience. This plan records a recommendation, not approval to ship it. Each phase should update `PROGRESS.csv` and append one evidence row to `HISTORY.csv` only after actual checks; no private sessions, capability URLs or raw logs may enter the public repository.

## Evidence and limits

- Existing implementation: `packages/pi-ui/src/host/`, `packages/pi-ui/src/client/`, `packages/ui/src/v4/PiConversationTimeline.tsx`; [TS-SLICE.md](TS-SLICE.md) records real browser checks, dual tool modes, known ephemeral limits, and upstream touch count.
- ZCode coupling: `packages/desktop/src/main/index.ts`, `packages/desktop/src/host/index.ts`, `packages/services/src/node.ts`, `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`, `packages/ui/src/v4/SessionPane.tsx`, `packages/ui/src/v4/V4ConversationContext.tsx`, `packages/ui/src/v4/ConversationTimeline.tsx`. Static audit in [AUDIT.md](AUDIT.md) is not a Desktop runtime trace.
- Pi 0.87.1 references: installed `docs/rpc.md` (ACK/settled and shutdown), `docs/rpc-commands.md` (`get_state`, `get_messages`, `get_entries`, `clear_queue`, `abort`), `docs/session-format.md` (tree and active branch), `docs/sessions.md` (storage), and `docs/security.md` (trust vs OS permissions). Recheck the installed version before treating these as a stable upgrade contract.
- Unknown until measured: Desktop startup side effects, packaged Pi CLI launch and licensing, real upstream incoming conflict rate, exact session-file corruption behavior and durable crash recovery. None is proven by the current Pi-only browser slice.
