# Isolated Pi GUI probe specification

Status: experimental local-only vertical slice. This is **not** the ZCode Desktop integration or a product release.

## Behavior / owner

A single Node host owns one Pi RPC child process and one in-memory session. Pi owns conversation history and tool execution. The host forwards a restricted state/events projection to one browser tab; the browser owns only its draft and rendering. No ZCode Host, task database, Z.ai account, updater, or renderer is initialized. No persistent sessions, multi-workspace support, or Pi plugin loading in this probe.

```text
browser prompt/stop -> local HTTP host -> Pi RPC prompt/clear_queue+abort
                                    <- JSONL response + session events
browser event stream <- sanitized host events (no raw credentials or logs)
```

Host binds `127.0.0.1` with an OS-selected port. It displays the URL containing a random path capability in the launching terminal, does not open a browser automatically, and rejects wrong path/origin and non-JSON or oversize POST bodies. This reduces browser-origin abuse but is **not** a multi-user OS security boundary. A local user with the URL can see this probe's transcript and submit prompts. Do not use it for private projects. `/health` reports only status, not transcript.

Pi launches with `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-context-files --tools read,grep,find,ls --offline`; this intentionally omits project instructions and coding tools. The experiment may send user prompts and read-only tool content to the configured model provider. An explicit `PI_CLI_PATH` may select another installed Pi CLI. Browser UI clearly labels restricted read-only capability and ephemeral session.

## Invariants and failure behavior

- Accept only one active prompt. `prompt` ACK means admitted, never completed; `agent_settled` ends the active run. Subscribe to child stdout before sending. Completed assistant text comes from `message_end`; deltas give live display and are not duplicated by final messages. A turn that settles before its ACK must still become idle.
- Stop first clears Pi's pending queue, then calls `abort`. If Pi has already settled, stop is a no-op. No host-side execution queue. A new session is not silently created after child exit.
- Unexpected child exit makes the UI unavailable and exposes only a bounded non-secret error. Do not auto-retry prompts because acceptance may be uncertain. Close the child on host shutdown and provide a bounded forced-exit fallback.
- On tab reconnect, send a bounded current-session snapshot from host memory (or fetch Pi `get_messages` later); the initial experiment may mark streaming text as incomplete if reconnect happens during a run. Never present it as durable recovery.
- Extension UI requests are unexpected with extensions disabled; fail visibly rather than claiming a permission decision. Do not claim ZCode permissions protect Pi tools.

## Acceptance

1. Fresh standalone checkout: `node scripts/pi-integration/pi-gui-server.mjs` reports a loopback URL, can serve a one-session page, and starts only a Pi RPC child (no ZCode Host/Agent or cron scheduler).
2. Browser can submit text, see streamed assistant text and read-only tool status, stop an active turn, and see idle/failed/aborted state. Missing Pi CLI and rejected prompt have visible errors.
3. Automated HTTP-level checks cover path/origin rejection, state retrieval, a live prompt, and stop ordering. A stop that arrives before the prompt ACK and a reconnect during streaming still need explicit targeted checks. Browser rendering is separate evidence.
4. Capture a process/network observation on this experimental entrypoint and distinguish launched processes from connections actually made. Neither source grep nor the presence of ZCode packages proves runtime behavior. Current idle observation on Windows: one Node GUI host listening on loopback and one Node Pi RPC child; no established TCP connection attributable to either at the observation instant. This is not a claim about network behavior during a model turn or about ZCode Desktop.
