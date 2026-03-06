# Investigating a Failure: Debugging a Failed or Stalled Run

This story covers the experience of diagnosing why a port run failed or produced unexpected results, using the observability surfaces the bot provides.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what a productive debugging session looks like. The maintainer should be able to go from "something went wrong" to "I understand what happened and why" without reading raw logs line by line. The observability architecture should make the answer discoverable at the right level of detail.

## Primary actor

- SDK maintainer responsible for a paired repo setup.

## Trigger

- A port run produced an unexpected result: a `failed` outcome, a stalled draft PR where the failure isn't obvious, a skip that shouldn't have been a skip, or a port that touched the wrong files.

## Preconditions

- Port bot workflow is installed and has run at least once.
- The maintainer has access to the source repo's Actions tab.

## Narrative

### Layer 1: Source PR comment (seconds)

1. **Maintainer sees the source PR comment**
    - Every outcome (including skips) produces a comment on the merged source PR when a source PR exists. The comment includes the outcome, a link to the target PR/issue (if created), and the decision reason.
    - For `failed` outcomes, the comment includes the run ID for correlation.
    - On reruns that succeed (or otherwise move past failure), the newer comment can explicitly supersede the prior failed comment and link back to it.
    - This is the fastest signal. The maintainer knows something went wrong and has a reason string to start with.

2. **Maintainer evaluates whether to dig deeper**
    - If the reason is self-explanatory (e.g., "Skipping because all changed files are documentation-only" but some weren't docs), the maintainer can adjust config and move on.
    - If the reason is opaque or the outcome doesn't match expectations, they proceed to the job summary.

### Layer 2: Job summary (minutes)

3. **Maintainer opens the Actions run**
    - From the source repo's Actions tab, they find the "Port Bot" workflow run for the relevant push event.
    - The **Summary tab** leads with:
        - H1 with the source PR title (e.g. `# Port: Add formatting/date helpers`).
        - One-liner with outcome and linked target PR: "Ported to [target-repo#3](url) · 39.5s".
        - Horizontal stage timing breakdown showing the pipeline flow and where time was spent.
        - Collapsible "Decision & diagnostics" section with decision kind, reason, model, artifact name, tool call count, and run ID.
    - This tells the maintainer which stage is the bottleneck or failure point. A decision that took 4.5s means the classifier ran (not a heuristic). An execution stage taking the bulk of the time means the agent was working. A missing delivery timing means the pipeline crashed before delivery.

4. **Maintainer checks stage timings for anomalies**
    - Context or config taking unusually long → possible GitHub API slowness or rate limiting.
    - Decision taking seconds → classifier was invoked; check the reason for quality.
    - Execution taking the bulk of the time → agent was working but possibly stuck in a loop.
    - Delivery failing → likely a git push or API permissions issue.

### Layer 3: Structured logs (minutes)

5. **Maintainer expands the Actions log**
    - The log is organized into collapsible groups: Context, Config, Decision, Attempt 1/3, Attempt 2/3, Deliver, Notify.
    - At `info` level, each group contains stage transition lines with key metrics:
        - `[port-bot] run=<id> stage=execute attempt=1/3 touched=3 validation=fail durationMs=4200`
        - `[port-bot] run=<id> stage=execute tool=Read file=src/example.ts`
    - During execution, the log shows real-time tool calls (which files the agent read, edited, wrote) so the maintainer can trace the agent's work without downloading the artifact.

6. **Maintainer optionally re-runs with debug logging**
    - If the `info`-level log isn't enough, the maintainer can re-trigger the workflow with `log-level: debug` to see:
        - Full validation stdout/stderr per command.
        - Resolved plugin config dump.
        - Agent thinking blocks (Claude's reasoning).
        - Per-tool-call durations.
        - API response details.
    - This requires manually triggering a re-run or adjusting the workflow input. In practice, most failures are diagnosable at `info` level.

### Layer 4: Artifacts (deep debugging)

7. **Maintainer downloads the run artifact**
    - Each run uploads `port-bot-run-<runId>/` containing:
        - `run-result.json` — the full `PortRunResult` including decision (with trace), execution (with trace), attempt details, and stage timings.
        - `tool-calls.json` — every `ToolCallEntry` across all execution attempts: tool name, raw input, raw output, duration. Note: this contains the full tool payloads (not summaries), so the file can be large.
        - `decision-tool-calls.json` — every `ToolCallEntry` from the decision classifier session (empty for heuristic decisions).
    - Artifacts are retained for 14 days alongside the Actions run.
    - Upload requires the runner-provided runtime token (`ACTIONS_RUNTIME_TOKEN`). If unavailable in a given context, upload is skipped and the run still succeeds.

8. **Maintainer searches the tool call log**
    - For stalled ports: find the last validation failure, trace backward through the agent's edits to see what it tried and where it went wrong.
    - For unexpected skips: check `run-result.json` for the decision kind and reason — the classifier may have misjudged.
    - For `failed` outcomes: the `run-result.json` captures the error message. The tool call log shows how far the agent got before the failure.

9. **Maintainer identifies the root cause and takes action**
    - **Config issue** (wrong path mappings, missing validation commands): adjust `port-bot.json` or workflow inputs. Next merge will use the updated config.
    - **Agent quality issue** (wrong edits, missed files): adjust the custom prompt, add naming conventions, or refine path mappings to give the agent better guidance.
    - **Infrastructure issue** (API 403, rate limit, timeout): fix token permissions or retry. The run ID correlates the failure across the source comment, job summary, and artifact.
    - **Classifier issue** (wrong decision): the classifier's reason string reveals its reasoning. Adjust ignore patterns or prompt to steer future decisions.

## User-visible definition of success

The maintainer experiences debugging as "layered and proportional":

- Most failures are explained by the source PR comment alone (layer 1).
- Ambiguous failures are resolved by the job summary's stage breakdown (layer 2).
- Complex agent failures are traceable through the structured log groups (layer 3).
- Deep debugging with full tool call replay is available but rarely needed (layer 4).
- The maintainer never has to grep through unstructured text to find the answer.

## Acceptance criteria

1. **Source comment always present**
    - Every outcome produces a source comment with the outcome and reason when a source PR exists. `failed` outcomes include the run ID. Even `skipped_not_required` posts a comment explaining the skip.

2. **Job summary is self-contained**
    - The summary tab shows outcome, decision, execution stats, and stage timings in a single glanceable view. No log expansion needed for the high-level picture.

3. **Structured log groups**
    - The Actions log is organized into named, collapsible sections. Expanding a section shows stage-specific detail at the configured log level.

4. **Artifact availability**
    - `run-result.json` and `tool-calls.json` are uploaded when runtime token env is available in the current runner context. If unavailable, upload is skipped (informationally) and does not affect the run outcome.

5. **Run ID correlation**
    - The same `runId` appears in the source PR comment, job summary, log lines, and artifact directory name. The maintainer can use it to cross-reference across all four layers.

6. **Debug mode accessible**
    - Setting `log-level: debug` in the workflow input produces verbose output without code changes or redeployment.

## Common investigation patterns

| Symptom                                 | Where to look                                  | What to check                                                                                                                       |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `failed` outcome, no PR/issue           | Source comment → job summary                   | Stage timings show which stage crashed. Error message in summary.                                                                   |
| Draft PR, unclear why validation failed | PR body → Actions log (expand Attempt groups)  | Validation results in PR body. Per-attempt tool calls in log.                                                                       |
| Unexpected skip                         | Source comment reason → PR body Decision Log   | Decision reason shows which heuristic fired or what the classifier inspected. Check if ignore patterns or labels are misconfigured. |
| Port touched wrong files                | Target PR diff → artifact                      | `tool-calls.json` shows which files the agent read and edited and in what order.                                                    |
| Run took too long                       | Job summary → stage timings                    | Identify the slow stage. Execution with many attempts is the usual culprit.                                                         |
| Agent went in circles                   | Actions log (expand Attempt groups) → artifact | Repeated tool calls on the same files across attempts. Tool call log shows the pattern.                                             |

## Non-goals

- Real-time alerting when a run fails. The source PR comment and GitHub Actions notification settings are sufficient for v1.
- Automated root cause analysis. The bot surfaces data; the maintainer interprets it.
- Cross-run trend analysis. v1 has no aggregation. Each run is investigated individually.
