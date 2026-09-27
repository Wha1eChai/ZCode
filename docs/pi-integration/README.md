# Pi GUI work notes

This directory tracks the Pi GUI fork's exploration. It is our project record, not an upstream ZCode specification. Dates in `HISTORY.csv` are local observations; verify them against the current checkout before acting on them.

- [PLAN.md](PLAN.md): overall architecture direction and validation gates.
- [NEXT-ROUND-PLAN.md](NEXT-ROUND-PLAN.md): the next presentation-reuse decision and acceptance checks.
- [AUDIT.md](AUDIT.md): static harness/plugin boundary audit and runtime checks still needed.
- [ISOLATED-GUI.md](ISOLATED-GUI.md): local Pi-only GUI experiment and its limits.
- [PROGRESS.csv](PROGRESS.csv): compact current status and next steps.
- [HISTORY.csv](HISTORY.csv): append-only experiments, maintenance changes, and upstream-sync results.

Working layout: this repository is a public fork of `zai-org/ZCode`; experimental probes live in [`scripts/pi-integration/`](../../scripts/pi-integration/). Keep upstream-specific changes as small as possible, and record evidence before claiming GUI integration is complete.
