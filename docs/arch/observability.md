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

| Question                                       | Anchor reference                              |
| ---------------------------------------------- | --------------------------------------------- |
| Did the port happen, and what was the outcome? | "What we measure each run" — outcome and URLs |
| Why did the engine decide to port (or skip)?   | Decision kind and rationale                   |
| How many attempts did it take?                 | Attempts used before success/failure          |
| Which validations passed or failed?            | Validation pass/fail per command              |
| What files were touched?                       | Files touched count                           |
| How long did the whole thing take?             | SLO: merge → PR open under 10 min             |
| What did the agent actually do?                | Tool call log + real-time streaming           |
| What is the agent doing right now?             | Streamed tool_start / thinking events         |

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

At `info` level, `runPort` emits one log line per stage transition so the Actions log tells a clear story. These lines are produced inside descriptive `group` sections for stage-level scanning, while the final outcome line stays outside groups so it is always visible.

```
[port-bot] run=<runId> stage=context source=acme/source-repo pr=42 files=5 contextMs=12
[port-bot] run=<runId> stage=config target=acme/target-repo configMs=3
[port-bot] run=<runId> stage=decision kind=PORT_REQUIRED decisionMs=4500
[port-bot] run=<runId> stage=execute tool=Read file=src/example.ts
[port-bot] run=<runId> stage=execute tool=Edit file=src/ported.ts
[port-bot] run=<runId> stage=execute attempt=1/3 touched=3 validation=pass durationMs=4200
[port-bot] run=<runId> stage=execute attempts=1 success=pass executeMs=4200
[port-bot] run=<runId> stage=deliver outcome=pr_opened deliverMs=3100
[port-bot] run=<runId> stage=notify outcome=pr_opened notifyMs=850
[port-bot] run=<runId> stage=outcome outcome=pr_opened durationMs=7800
```

At `debug` level, each stage additionally logs structured detail: full file lists, resolved config, classifier reasoning, validation stdout/stderr per command, delivery git operations, agent thinking blocks, and per-tool-call durations.

Note: `decisionMs` varies significantly depending on whether a fast heuristic matched (sub-millisecond) or the LLM-backed classifier was invoked (seconds). When the classifier runs, the decision stage uses read-only tools and the SDK's structured output format to produce a validated `{ required, reason }` response.

### Agent streaming

During execution, the `ClaudeAgentProvider` emits structured `AgentMessage` events via an `onMessage` callback on `AgentInput`. The execution orchestrator routes these to the logger:

| AgentMessage kind | Log level | What it shows                                                           |
| ----------------- | --------- | ----------------------------------------------------------------------- |
| `tool_start`      | **info**  | One line per tool call with normalized relative file path when possible |
| `thinking`        | **debug** | Claude's reasoning — verbose, for troubleshooting                       |
| `tool_end`        | **debug** | Tool duration — captured in toolCallLog anyway                          |
| `text`            | **debug** | Agent summary text — already in AgentOutput                             |

This means at `info` level an operator sees real-time progress (which files Claude is reading/editing) without noise. At `debug` level they also see Claude's internal reasoning and tool timing.

### Collapsible groups

At `info` level and above, the logger emits `core.group()` / `core.endGroup()` boundaries so runs are organized into top-level collapsible sections in the Actions UI.

Typical collapsed view:

```
> Context: acme/source-repo PR #42 (5 files)
> Config: target=acme/target-repo
> Decision: PORT_REQUIRED
> Attempt 1/3
> Deliver: pr_opened
> Notify: source PR comment
[port-bot] run=<runId> stage=outcome outcome=pr_opened durationMs=7800
```

Notes:

- Groups are intentionally flat in Actions (no nesting).
- Stage and attempt detail lines are emitted inside these groups.
- The outcome line remains outside groups for immediate visibility.

## Job summary

The action writes a summary via `core.summary` including:

- Run ID, outcome, duration
- Source PR link and target PR/issue link
- Decision rationale (one line)
- Attempt count and final validation status
- Timing breakdown (context, decision, execution, delivery)

This gives the maintainer a glanceable dashboard directly in the Actions UI without expanding the full log.

## Tool call artifact

The agent's `ToolCallEntry[]` is the most valuable debugging artifact but also the noisiest (50–200 entries per attempt across multiple retries). It should not go to stdout at `info` level.

Instead, it is written to a JSON file and uploaded as a GitHub Actions artifact:

```
port-bot-run-<runId>/
  tool-calls.json      # Full ToolCallEntry[] across all attempts
  run-result.json      # Serialized PortRunResult
```

Uploaded via the runtime artifact client with a short retention (7–14 days). Upload requires `ACTIONS_RUNTIME_TOKEN`; if the token is unavailable for the runner context, upload is skipped and the run still succeeds.

When a port goes wrong the operator downloads the artifact, searches for the failing tool call, and sees exactly what the agent did.

## Timing

`PortRunResult.durationMs` captures total wall-clock time. Per-stage timing is stored in `PortRunResult.stageTimings` and logged at each stage transition:

| Measurement             | Where                                      |
| ----------------------- | ------------------------------------------ |
| Total run duration      | `PortRunResult.durationMs`                 |
| Context gathering       | `stageTimings.contextMs` + stage log line  |
| Config resolution       | `stageTimings.configMs` + stage log line   |
| Decision                | `stageTimings.decisionMs` + stage log line |
| Execution (per attempt) | `stageTimings.executeMs` + stage log line  |
| Delivery                | `stageTimings.deliverMs` + stage log line  |
| Source PR comment       | `stageTimings.notifyMs` + stage log line   |

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
- **Best-effort operations** (source PR comment, artifact upload) never affect the run outcome. Artifact upload skips at `info` level when runtime token env is unavailable; upload errors still log at `warn` level.
- **Sensitive data** (tokens, API keys) must never appear in logs. The engine logs repo names, PR numbers, file paths, and outcomes — never credentials or full API response bodies.
