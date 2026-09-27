# Pi GUI work notes

This directory tracks the Pi GUI fork's exploration. It is our project record, not an upstream ZCode specification. Dates in `HISTORY.csv` are local observations; verify them against the current checkout before acting on them.

- [MASTER-PLAN.md](MASTER-PLAN.md): current proposed Pi-owned Desktop integration route, alternatives, work packages and evidence gates.
- [PLAN.md](PLAN.md): historical initial architecture direction and validation gates.
- [NEXT-ROUND-PLAN.md](NEXT-ROUND-PLAN.md): presentation-reuse decision and acceptance checks.
- [TS-SLICE.md](TS-SLICE.md): the implemented Pi-only TS/TSX slice, ownership contract and local validation.
- [AUDIT.md](AUDIT.md): static harness/plugin boundary audit and runtime checks still needed.
- [ISOLATED-GUI.md](ISOLATED-GUI.md): local Pi-only GUI experiment and its limits.
- [PROGRESS.csv](PROGRESS.csv): compact current status and next steps.
- [HISTORY.csv](HISTORY.csv): append-only experiments, maintenance changes, and upstream-sync results.

## Current milestone evidence

At the 2026-09-27 check, the live `upstream/main` SHA `29628c9acdb81b703bbd4080c207a0e7ce5e276e` matched cached `upstream/main` and was an ancestor of `main` (`7d28afac6194a9b33a130276480a73e63e867fe9` at that check). There were no new upstream commits to merge; no merge was performed. The Pi slice touches three tracked existing upstream files (`AGENTS.md`, `packages/ui/package.json`, `pnpm-lock.yaml`) and adds the UI export at `packages/ui/src/v4/PiConversationTimeline.tsx`.

The Pi GUI now has two **startup-only** tool modes: default `read-only` (`read,grep,find,ls`) and explicit `full` (adds `bash,edit,write`). This does not change Pi's general default tool selection, add per-tool approval, or enable extension tools. There is no OS sandbox: anyone with the local capability URL can request actions using the OS account's permissions. This remains trusted-local experimentation, not Desktop integration, persisted-session recovery, or production security isolation. The prior read-only build baseline was 1,930 files / 29,654,245 raw bytes and 4,470,180 bytes of first-load static JS; the current mode-enabled build is 1,930 files / 29,655,554 raw bytes and 4,471,489 bytes of first-load static JS. These are raw output sizes, not network transfer sizes. See [TS-SLICE.md](TS-SLICE.md) for validation details and remaining limits.

Working layout: this repository is a public fork of `zai-org/ZCode`; the Pi-only TS GUI lives in [`packages/pi-ui/`](../../packages/pi-ui/), while earlier `.mjs` probes remain in [`scripts/pi-integration/`](../../scripts/pi-integration/). Build with `pnpm --dir packages/pi-ui build`, then launch with `pnpm --dir packages/pi-ui dev:host` for read-only tools or `pnpm --dir packages/pi-ui dev:host --tool-mode full` for shell/edit/write; open the one-time URL printed locally. The session is ephemeral in either mode, not ZCode Desktop or durable session integration. Keep upstream-specific changes as small as possible.
