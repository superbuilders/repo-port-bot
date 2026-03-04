# Observability

How the engine surfaces what happened during a port run, why it happened, and how long it took. Covers logging, artifacts, and the constraints imposed by running inside ephemeral GitHub Actions runners.

## Environment constraints

Every port run executes as a single GitHub Actions job. There is no persistent server, no sidecar, no always-on log collector. When the job finishes the VM is destroyed. This means:

- **stdout / stderr** → Actions log viewer (retained ~90 days by default).
- **Job summary** → `core.summary` renders rich markdown on the run's Summary tab.
- **Action outputs** → `run-id`, `outcome`, `pr-url`, etc., available to downstream workflow steps.
- **Artifacts** → files explicitly uploaded via `actions/upload-artifact`, retained alongside the run.
- **PR / issue bodies** → durable, searchable, survive log retention.

There is no built-in log aggregation, metrics store, or cross-run query surface. Anything that needs to outlive the runner must be written to one of these five channels.

## What we need to observe

Grounded in the [anchor story](../user-stories/anchor.md), the key questions after any run are:

| Question                                       | Anchor reference                               |
| ---------------------------------------------- | ---------------------------------------------- |
| Did the port happen, and what was the outcome? | "What we measure each run" — outcome and URLs  |
| Why did the engine decide to port (or skip)?   | Decision kind and rationale                    |
| How many attempts did it take?                 | Attempts used before success/failure           |
| Which validations passed or failed?            | Validation pass/fail per command               |
| What files were touched?                       | Files touched count                            |
| How long did the whole thing take?             | SLO: merge → PR open under 10 min              |
| What did the agent actually do?                | Tool call log (for debugging unexpected edits) |

## Log levels

The engine uses a simple four-level scheme. The action input `log-level` controls the minimum level emitted to stdout. Default: `info`.

| Level   | Purpose                                                        | Example                                        |
| ------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `error` | Failures that terminate the run or a stage                     | `Engine failure: GitHub API returned 403`      |
| `warn`  | Non-fatal issues the operator should know about                | `Source PR comment failed (best-effort)`       |
| `info`  | Stage transitions, outcomes, timing — the run narrative        | `Decision: PORT_REQUIRED (docs + code change)` |
| `debug` | Verbose internals: API payloads, file lists, config resolution | `Resolved plugin config: { targetRepo: ... }`  |

### Mapping to GitHub Actions

- `error` → `core.error()` (annotation in the Actions UI)
- `warn` → `core.warning()` (annotation)
- `info` → `core.info()` (normal log line)
- `debug` → `core.debug()` (only visible when the runner's `ACTIONS_STEP_DEBUG` secret is set, or when `log-level` is explicitly `debug`)

### Action input

```yaml
inputs:
    log-level:
        description: Minimum log level for stdout output (error, warn, info, debug).
        required: false
        default: info
```

This keeps the default output scannable for a maintainer checking "did the port work?" while allowing `debug` when investigating a failure.

## Structured stage logging (stdout)

At `info` level, `runPort` emits one log line per stage transition so the Actions log tells a clear story:

```
[port-bot] run=<runId> stage=context source=acme/source-repo pr=#42 files=5
[port-bot] run=<runId> stage=config source=port-bot.json+built-in target=acme/target-repo
[port-bot] run=<runId> stage=decision kind=PORT_REQUIRED reason="Code + test changes" signals=[] 12ms
[port-bot] run=<runId> stage=execute attempt=1/3 touched=3 validation=pass 4.2s
[port-bot] run=<runId> stage=deliver outcome=pr_opened url=https://github.com/acme/target-repo/pull/99 3.1s
[port-bot] run=<runId> stage=notify commented=https://github.com/acme/source-repo/pull/42#issuecomment-1
[port-bot] run=<runId> outcome=pr_opened duration=7.8s
```

At `debug` level, each stage additionally logs structured detail: full file lists, resolved config, decision signals, validation stdout/stderr per command, and delivery git operations.

### Collapsible groups

Long output (validation stderr, file lists, config dumps) is wrapped in `core.group()` / `core.endGroup()` so the Actions log stays scannable even at `debug` level.

## Job summary

The action already writes a summary via `core.summary`. This should include:

- Run ID, outcome, duration
- Source PR link and target PR/issue link
- Decision rationale (one line)
- Attempt count and final validation status
- Timing breakdown (context, decision, execution, delivery)

This gives the maintainer a glanceable dashboard directly in the Actions UI without expanding the full log.

## Tool call artifact

The agent's `ToolCallEntry[]` is the most valuable debugging artifact but also the noisiest (50–200 entries per attempt across multiple retries). It should not go to stdout.

Instead, write it to a JSON file and upload as a GitHub Actions artifact:

```
port-bot-run-<runId>/
  tool-calls.json      # Full ToolCallEntry[] across all attempts
  run-result.json      # Serialized PortRunResult
```

Uploaded via `actions/upload-artifact` with a short retention (7–14 days). When a port goes wrong the operator downloads the artifact, searches for the failing tool call, and sees exactly what the agent did.

At `debug` level, a one-line summary of each tool call (name + duration) is additionally logged to stdout for real-time tailing.

## Timing

`PortRunResult.durationMs` captures total wall-clock time. Per-stage timing should also be captured so operators can identify bottlenecks:

| Measurement             | Where                               |
| ----------------------- | ----------------------------------- |
| Total run duration      | `PortRunResult.durationMs` (exists) |
| Context gathering       | Logged at stage transition          |
| Decision                | Logged at stage transition          |
| Execution (per attempt) | Logged at stage transition          |
| Delivery                | Logged at stage transition          |
| Source PR comment       | Logged at stage transition          |

These are logged, not stored in protocol types. If cross-run analysis becomes valuable later, they can be promoted to `PortRunResult`.

## Cross-run visibility

v1 has no cross-run query surface. Each run is isolated. Correlation happens manually via:

- `runId` in PR bodies, source comments, and job summaries
- GitHub Actions "workflow runs" UI (filterable by status, branch)
- Source PR comment history (shows all port attempts for a given PR)

### Future options (post-first-run)

When running frequently enough to need aggregate analysis:

- **GitHub Actions job summary + CSV artifact**: append a one-line CSV per run to a cumulative artifact; parse offline.
- **Webhook / external sink**: ship structured events to PostHog, Datadog, or a lightweight webhook endpoint. Requires adding a secret.
- **Dedicated metrics branch**: commit structured JSON per run to a branch in the bot's own repo. Queryable via git log.

These are deferred until there's enough run volume to justify the setup.

## Error handling philosophy

- **Stage failures** are caught by `runPort`'s error boundary and produce a `failed` outcome with an error summary. The failure is logged at `error` level and surfaced in the job summary and source PR comment.
- **Best-effort operations** (source PR comment, artifact upload) catch their own errors, log at `warn` level, and never affect the run outcome.
- **Sensitive data** (tokens, API keys) must never appear in logs. The engine logs repo names, PR numbers, file paths, and outcomes — never credentials or full API response bodies.

## Implementation order

1. Add `log-level` action input with `info` default.
2. Add a thin logger interface that the engine accepts (maps to `core.*` in Actions, `console.*` locally).
3. Instrument `runPort` stage transitions at `info` level.
4. Add `debug` logging in each stage for verbose detail.
5. Write tool call artifact + run result JSON after pipeline completes.
6. Enhance job summary with timing breakdown.
