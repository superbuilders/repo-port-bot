# Stalled Port: Draft PR After Validation Failure

This story covers the most common non-happy-path outcome: the agent applied changes but validation never passed within the retry budget.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what "good failure" looks like when an automated port is attempted but can't fully validate. The maintainer should be able to pick up where the bot left off without starting from scratch.

See [`docs/arch/state-machine.md`](../arch/state-machine.md) for the canonical artifact-selection logic.

## Primary actor

- SDK maintainer responsible for a paired repo setup.

## Trigger

- A pull request is merged into the source repository default branch.
- Deterministic operations are applied (if configured). They may or may not produce target-side changes.
- The residual classification returns `PORT_REQUIRED` and agent execution begins.
- The agent applies changes on top of the deterministic baseline, but validation commands fail on every attempt through the retry budget.

## Preconditions

- Port bot workflow is installed in the source repo.
- Required secrets are configured.
- Repo pairing config exists.
- Loop prevention signals are enabled.
- At least one validation command is configured (otherwise there's nothing to fail).
- `maxAttempts` is set (default 3). The agent has used all of them.

## Narrative

1. **Maintainer merges source PR**
    - A normal feature/fix PR is merged in source repo.
    - Maintainer does not take any manual action.

2. **Engine runs through context, config, deterministic operations, classification**
    - Workflow fires on push. Engine gathers source PR metadata, changed files, and diff. Plugin config is resolved. Deterministic operations are applied to the target working tree. Residual classification returns `PORT_REQUIRED`.

3. **Agent attempts the residual port**
    - The agent works on top of the deterministic baseline already applied in the target working tree.
    - On each attempt, the agent reads the source diff, applies edits in the target repo, and the orchestrator runs validation commands against the combined working tree (deterministic + agent edits).
    - Validation fails. The agent receives the failing command's name, exit code, stdout, and stderr as retry feedback and attempts a fix.
    - This repeats until `maxAttempts` is exhausted.
    - The working directory is incremental — each attempt builds on the previous one, so partial progress is preserved.

4. **Execution returns `success: false`**
    - The `ExecutionResult` carries the full attempt history: files touched per attempt, validation results (which commands passed/failed, exit codes, stdout, stderr), agent notes, a `failureReason` summarizing the final state, and an `incompleteReason` when the agent was cut off before finishing (e.g. "reached max turns", "reached budget limit").

5. **Draft PR is opened (or updated) in target repo**
    - The delivery stage commits the agent's final working tree state (even though validation failed) and force-pushes the port branch. If the branch already exists from a previous run, the force-push replaces it.
    - A **draft** pull request is created. If one already exists for the same port branch (from a prior attempt), the existing PR is updated with the new body instead of creating a duplicate.
    - The maintainer should experience one stable draft PR for the stalled port, with reruns refreshing that artifact rather than scattering work across multiple draft PRs.
    - Labels applied: `auto-port` + `port-stalled`.
    - PR body follows the same compact layout as successful ports, but with key differences:
        - `## Port rationale` heading with the decision rationale quoted/blocked
        - source narrative directly below, extended into a natural provenance sentence that includes a parenthetical `@`-mention of the original PR author (so they receive a GitHub notification about the stalled port without implying they authored the port itself) and includes model name and at-a-glance execution stats
        - collapsed `Cost & Tokens` block showing decision totals, execution totals aggregated across attempts, and overall run totals
        - `## What was ported` — polished summary of what changed
        - collapsed `Work Log` with assistant notes in italics and tool actions in code blocks; the final summary is deduplicated (not repeated in the log). For retries, per-attempt headings (`### Attempt 1`, `### Attempt 2`, etc.)
        - `Validation & diagnostics` section is **expanded by default** (`<details open>`) since the failure is the point — shows which commands passed/failed with exit codes, and includes captured stdout/stderr output in fenced code blocks so the reviewer can see exactly what failed
        - `Ported by: Repo Port Bot` footer linking to the bot repository (loop prevention remains the git trailer `Ported-By: repo-port-bot`)
        - If the body exceeds GitHub's 65,536-character limit (common with multi-attempt runs and verbose validation output), the engine progressively truncates validation output, then work log content, to fit within the limit

6. **Source PR receives a notification comment**
    - Best-effort `[!WARNING]` admonition comment on the merged source PR indicating validation failed and a draft PR was opened, with a collapsible reason.
    - The comment also includes a collapsed `Cost & Tokens` block so the maintainer can see decision totals, execution totals across retries, and the overall spend/token footprint without opening the Actions run first.
    - This is how the maintainer discovers the stall without having to check the target repo.

7. **Maintainer triages the draft PR**
    - Maintainer clicks through from the source PR comment (or finds the draft PR in the target repo's PR list via the `port-stalled` label).
    - They read the PR body to understand:
        - What the agent changed (files touched).
        - What validation looks like (which commands passed/failed and why).
        - What the agent's notes say about uncertainty or incomplete work.
    - They check out the branch locally and inspect the diff.

8. **Maintainer resolves the stall**
    - **Fix and merge**: push commits onto the draft branch to fix remaining validation failures, mark the PR as ready for review, and merge. This is the ideal outcome — the bot did most of the work, the human finishes the last mile.
    - **Close and redo**: if the agent's changes are too far off, close the draft PR and port manually from scratch. The PR body still serves as documentation of what was attempted.
    - **Investigate further**: if the failure is non-obvious, the maintainer navigates to the GitHub Actions run (linked from the job summary) and optionally downloads the `tool-calls.json` artifact for a full trace of what the agent did.

## User-visible definition of success

The maintainer experiences the stall as "the bot got close and told me exactly where it got stuck":

- The draft PR appears shortly after source merge (under 10 minutes).
- The PR body gives enough context to understand the failure without re-reading the source diff from scratch.
- The `port-stalled` label makes stalled ports filterable and trackable.
- The maintainer's remediation effort is proportional to the gap, not proportional to the full port.

## Acceptance criteria

1. **Draft, not ready**
    - When validation fails after all retries, the target PR is opened as a draft. Never as a ready-for-review PR.

2. **Idempotent draft reuse**
    - For the same source change, reruns reuse the same deterministic branch and the same open draft PR rather than creating duplicate stalled PRs.

3. **Stalled label**
    - Draft PR carries the `port-stalled` label in addition to `auto-port`.

4. **Diagnostic body**
    - PR body includes validation results (pass/fail per command with exit codes), failure reason, files touched, per-attempt notes, and collapsed cost/token telemetry. The displayed token totals are input/output-only for readability. A reviewer should not need to open the Actions log to understand what went wrong at a high level.

5. **All progress preserved**
    - The committed state includes both deterministic changes (if any) and the agent's best effort across all attempts. Deterministic progress is never lost even when agent-authored edits fail validation.

6. **Source notification**
    - Source PR receives a comment linking to the draft PR. The maintainer who merged the source PR gets notified through GitHub's existing subscription model.

7. **No false confidence**
    - The draft state and label together ensure that automated merge rules (branch protection, auto-merge) do not accidentally merge a stalled port.

## When this outcome is most likely

- The source change touches patterns the agent handles well (straightforward file mapping) but also patterns it doesn't (new APIs, changed signatures, test fixtures that need target-specific data).
- Validation commands catch real issues (type errors, test failures) that the agent cannot resolve within the retry budget.
- The source change is large enough that partial success is valuable — some files port cleanly, others don't.
  -The target repo needs a dependency install step (e.g., `uv sync --all-packages`) before validation tools work, but no `setup` field is configured in `port-bot.json`.

## Non-goals

- Automatically escalating stalled ports to issues or alerts. The draft PR and source comment are sufficient notification for v1.
- Re-running a stalled port automatically. The maintainer decides whether to fix the branch or start over.
- Guaranteeing the agent's partial work is "close" to correct. Sometimes the agent goes down a wrong path and the draft is more noise than signal. The diagnostic body should make this obvious quickly.
