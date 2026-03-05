# Stalled Port: Draft PR After Validation Failure

This story covers the most common non-happy-path outcome: the agent applied changes but validation never passed within the retry budget.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what "good failure" looks like when an automated port is attempted but can't fully validate. The maintainer should be able to pick up where the bot left off without starting from scratch.

## Primary actor

- SDK maintainer responsible for a paired repo setup.

## Trigger

- A pull request is merged into the source repository default branch.
- The engine decides `PORT_REQUIRED` and begins execution.
- The agent applies changes, but validation commands fail on every attempt through the retry budget.

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

2. **Engine runs through context, config, decision**
    - Workflow fires on push. Engine gathers source PR metadata, changed files, and diff. Plugin config is resolved. Decision stage returns `PORT_REQUIRED`.

3. **Agent attempts the port**
    - On each attempt, the agent reads the source diff, applies edits in the target repo, and the orchestrator runs validation commands.
    - Validation fails. The agent receives the failure output and attempts a fix.
    - This repeats until `maxAttempts` is exhausted.
    - The working directory is incremental — each attempt builds on the previous one, so partial progress is preserved.

4. **Execution returns `success: false`**
    - The `ExecutionResult` carries the full attempt history: files touched per attempt, validation results (which commands passed, which failed, exit codes), agent notes, and a `failureReason` summarizing the final state.

5. **Draft PR is opened in target repo**
    - The delivery stage commits the agent's final working tree state (even though validation failed) and pushes a port branch.
    - A **draft** pull request is created — not ready for merge, clearly signaling incomplete work.
    - Labels applied: `auto-port` + `port-stalled`.
    - PR body includes:
        - Link to the source PR.
        - Decision kind and reason.
        - Files touched across all attempts.
        - Validation summary showing which commands passed and which failed (with exit codes).
        - Final status line: "validation failed after retries" with the failure reason.
        - Compact execution metrics (attempts, files touched, tool call count).
        - Per-attempt notes in stable sections (for example `### Attempt 1`), including what the agent tried and uncertainty flags.
        - `Ported-By: repo-port-bot` footer (loop prevention).

6. **Source PR receives a notification comment**
    - Best-effort comment on the merged source PR: "Port attempted but validation failed after retries. Opened a draft PR: `<url>`."
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

2. **Stalled label**
    - Draft PR carries the `port-stalled` label in addition to `auto-port`.

3. **Diagnostic body**
    - PR body includes validation results (pass/fail per command with exit codes), failure reason, files touched, and per-attempt notes. A reviewer should not need to open the Actions log to understand what went wrong at a high level.

4. **Incremental progress preserved**
    - The committed state reflects the agent's best effort across all attempts, not just the first or last. Partial fixes from earlier attempts are preserved.

5. **Source notification**
    - Source PR receives a comment linking to the draft PR. The maintainer who merged the source PR gets notified through GitHub's existing subscription model.

6. **No false confidence**
    - The draft state and label together ensure that automated merge rules (branch protection, auto-merge) do not accidentally merge a stalled port.

## When this outcome is most likely

- The source change touches patterns the agent handles well (straightforward file mapping) but also patterns it doesn't (new APIs, changed signatures, test fixtures that need target-specific data).
- Validation commands catch real issues (type errors, test failures) that the agent cannot resolve within the retry budget.
- The source change is large enough that partial success is valuable — some files port cleanly, others don't.

## Non-goals

- Automatically escalating stalled ports to issues or alerts. The draft PR and source comment are sufficient notification for v1.
- Re-running a stalled port automatically. The maintainer decides whether to fix the branch or start over.
- Guaranteeing the agent's partial work is "close" to correct. Sometimes the agent goes down a wrong path and the draft is more noise than signal. The diagnostic body should make this obvious quickly.
