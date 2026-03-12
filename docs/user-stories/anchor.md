# Anchor Story: Successful Auto-Port

This is the canonical user-story for `repo-port-bot`.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what "working" means from a maintainer perspective when a change in one repo should be mirrored in another repo with minimal human effort.

## Primary actor

- SDK maintainer responsible for a paired repo setup (for example TypeScript SDK + Python SDK).

## Trigger

- A pull request is merged into the source repository default branch.

## Preconditions

- Port bot workflow is installed in the source repo.
- Required secrets are configured:
    - `PORT_BOT_LLM_API_KEY`
    - `PORT_BOT_GITHUB_TOKEN` (or split `PORT_BOT_SOURCE_GITHUB_TOKEN` / `PORT_BOT_TARGET_GITHUB_TOKEN`)
- Repo pairing config exists (built-in plugin and/or source repo `port-bot.json`).
- Loop prevention is enabled (the `auto-port` label applied to bot-created PRs prevents echo loops).

## Success narrative (happy path)

1. **Maintainer merges source PR**
    - A normal feature/fix PR is merged in source repo.
    - Maintainer does not take any manual "port" action.

2. **Workflow starts automatically**
    - GitHub Action fires on `push` to default branch.
    - Engine creates a run with a stable `runId`.

3. **Engine gathers context**
    - Source PR metadata is fetched (title/body/labels/URL).
    - Changed files and diff summary are fetched.
    - Plugin configuration is resolved for this repo pair.

4. **Engine checks for pre-deterministic skip signals**
    - Before touching the target working tree, the engine checks for signals that suppress the entire run:
        - missing source pull request → skip (no PR metadata)
        - `auto-port` label → skip (loop prevention)
        - `no-port` label → skip (explicit opt-out)
    - If any of these match, the run exits immediately with `skipped_not_required`. No deterministic operations run, no target-side mutation occurs.

5. **Engine applies deterministic operations**
    - If deterministic operations are configured in `port-bot.json` (currently: file syncing via the `sync` key), the engine applies them to the target working tree before any residual classification or agent execution.
    - Deterministic operations are engine-owned and declarative. They do not involve the agent. The operation kind determines the behavior (e.g., mirror, copy).
    - This step may or may not produce target-side changes depending on whether the source change touched paths covered by configured operations.

6. **Engine classifies the residual work**
    - Classification evaluates the work that remains after deterministic operations, not the full source change.
    - Fast heuristics run first and can short-circuit the decision:
        - docs-only, config-only → `PORT_NOT_REQUIRED`
        - all files match ignore patterns → `PORT_NOT_REQUIRED`
    - If no heuristic matches, the LLM classifier makes the call:
        - `PORT_REQUIRED`, `PORT_NOT_REQUIRED`, or `NEEDS_HUMAN`
    - In the happy path, the result is `PORT_REQUIRED`.

7. **Agent executes the residual port** (see [agent loop spec](../arch/agent-loop.md))
    - The agent works on top of the deterministic baseline already applied in the target working tree.
    - Agent applies equivalent changes for the residual work using source context + plugin config.
    - Validation commands run against the combined working tree (deterministic + agent edits); on failure the agent iterates (read error → fix → rerun).
    - In the happy path, validations pass within the retry budget.

8. **PR is opened (or updated) in target repo**
    - On first run, a new PR is created. On re-runs where the port branch already has an open PR, the existing PR is updated with fresh output rather than failing.
    - The maintainer should experience one stable target PR for a given source change, not a stream of duplicate PRs on each rerun.
    - PR title follows predictable format:
        - `Port: <source PR title>`
    - PR body follows a compact layout:
        - `## Port rationale` heading with the decision rationale quoted/blocked (the "why" is the first thing a reviewer reads)
        - source narrative directly below, extended into a natural provenance sentence that includes a parenthetical `@`-mention of the original PR author (so they receive a GitHub notification about the port without implying they authored the port itself) and includes model name and at-a-glance execution stats
        - collapsed `Cost & Tokens` block showing decision totals, execution totals, and overall run totals
        - `## What was ported` — the agent's per-file summary of changes (the main content)
        - collapsed `Work Log` with assistant notes in italics and tool actions in code blocks; the final summary is deduplicated (only shown in "What was ported", not repeated in the log)
        - collapsible `Validation & diagnostics` section with pass/fail results
        - `Ported by: Repo Port Bot` footer linking to the bot repository (loop prevention signal remains the git trailer `Ported-By: repo-port-bot`)

9. **Maintainer reviews a small, traceable PR**
    - Maintainer sees a focused change set.
    - PR links cleanly back to original source PR.
    - Review effort is mostly verification, not re-implementation.

## User-visible definition of success

The maintainer experiences porting as "automatic and reviewable":

- A target PR appears quickly after source merge.
- The PR is behaviorally aligned with the source change.
- Validation evidence is already attached.
- The change is small enough to review without reverse-engineering the source diff.

## Acceptance criteria (v1)

1. **Automation**
    - Given a qualifying merged source PR, bot opens exactly one target PR without manual intervention. Re-runs update the existing PR rather than creating duplicates.

2. **Idempotent target artifact**
    - For a given source change, the bot maintains one stable target artifact for the successful port path: the same deterministic branch and the same open PR are reused across reruns.

3. **Traceability**
    - Target PR contains a link to source PR in the body and source PR title in the PR title.
    - Target PR body `@`-mentions the original PR author so they receive a GitHub notification about the port. This is critical when the author is subscribed to the source repo but not the target repo — without the mention, they would have no visibility into whether their change was ported.
    - For all outcomes (including skips), source PR receives a bot comment with a collapsible reason. Stalled / needs-human / failed / skipped outcomes use GitHub admonitions; successful `pr_opened` comments are plain markdown.
    - When available, both the target PR and the source PR comment include a collapsed `Cost & Tokens` block. Successful and stalled runs show decision totals, execution totals, and overall totals; decision-only outcomes show decision totals only.
    - The displayed token totals are input/output-only for readability. Cache token buckets are still tracked internally and still contribute to cost accounting.
    - Repositories can opt out of these user-facing telemetry blocks via the action input `include-cost-telemetry: false` without disabling the underlying port workflow.
    - On reruns, the bot updates the same source PR comment for this target repo so maintainers always see one stable latest-status artifact rather than a growing comment chain.

4. **Correctness gate**
    - Target PR is only marked "ready" when configured validation commands pass.

5. **Iteration behavior**
    - At least one validation failure can be auto-recovered in-run (fix + rerun) when within retry budget.

6. **Loop safety**
    - Bot-created port PR merges do not re-trigger an opposite-direction echo port.

7. **Deterministic progress preserved**
    - When deterministic operations (sync rules) produce target-side changes, those changes are preserved in a PR regardless of the residual classification outcome.

8. **Fallback quality**
    - If retries are exhausted, bot opens a draft PR with `port-stalled` label and clear "where it got stuck" notes.
    - If the port decision is `NEEDS_HUMAN` and no deterministic changes exist, bot opens or updates one issue tagged `needs-human` linking to the source PR.
    - If the port decision is `NEEDS_HUMAN` but deterministic changes exist, bot opens a ready PR containing the deterministic changes with an explicit residual handoff note.

## Non-goals for this story (v1)

- Fully autonomous handling of every large refactor.
- Formal proof of semantic equivalence.
- Zero human review.

## Guardrails and invariants

- No execution of arbitrary code from repo configuration.
- Plugin/config only influences behavior through validated declarative inputs.
- Workflow permissions are least-privilege.
- Secrets are sourced from GitHub Actions secrets only.
- A port run always ends in one terminal outcome:
    - `skipped_not_required` — pre-deterministic skip (missing PR, `auto-port`, or `no-port`), or no deterministic changes and residual classification returned `PORT_NOT_REQUIRED`
    - `needs_human` — no deterministic changes and residual classification returned `NEEDS_HUMAN`; issue opened
    - `pr_opened` — target-side changes exist (deterministic and/or agent-authored), validations pass, PR ready for review
    - `draft_pr_opened` — target-side changes exist but validations failed after retries; draft PR with notes
    - `failed` — engine-level error (crash, timeout, API failure) prevented completion; best-effort cleanup
- The full artifact-selection logic is documented in [`docs/arch/state-machine.md`](../arch/state-machine.md).

## Operational SLO targets (initial)

- Median source merge -> target PR open: under 10 minutes.
- Successful non-draft ports for eligible PRs: at least 70% in early rollout.
- Zero confirmed loop incidents.

## What we measure each run

- Decision kind and rationale.
- Attempts used before success/failure.
- Validation pass/fail per command.
- Files touched count.
- Final outcome and URLs produced.

## Pivot log (keep current)

Use this section to record intentional changes to the anchor story.

### 2026-03-11 — Deterministic operations phase

- **Date**: 2026-03-11
- **What changed**: Added a deterministic operations phase that runs before classification. Classification now evaluates residual work only. Deterministic changes can produce a PR even when the port decision is `PORT_NOT_REQUIRED` or `NEEDS_HUMAN`.
- **Why**: Source changes that contain both mechanical work (fixture sync, file mirroring) and target-specific work should not lose the mechanical portion when the agent cannot handle the rest. Deterministic operations are independently safe to merge and should always land.
- **Impact on success definition**: `NEEDS_HUMAN` no longer always means "issue only." When deterministic changes exist, `NEEDS_HUMAN` produces a ready PR with a residual handoff note instead. The terminal outcome list and acceptance criteria are updated to reflect this.
- **Follow-up implementation tasks**: Add `sync` config to `port-bot.json` schema, add deterministic phase to engine pipeline, update delivery to handle deterministic-only and mixed PRs, update PR rendering for new framing modes.

### Pivot template

- **Date**:
- **What changed**:
- **Why**:
- **Impact on success definition**:
- **Follow-up implementation tasks**:
