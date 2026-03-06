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
- Loop prevention signals are enabled (`auto-port` label and at least one additional signal).

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

4. **Engine decides whether porting is required**
    - Fast heuristics run first and can short-circuit the decision:
        - docs-only, config-only → `PORT_NOT_REQUIRED`
        - `no-port` label → `PORT_NOT_REQUIRED`
        - `auto-port` label → `PORT_NOT_REQUIRED` (loop prevention)
    - If no heuristic matches, the LLM classifier makes the call:
        - `PORT_REQUIRED` or `PORT_NOT_REQUIRED`
    - In the happy path, the result is `PORT_REQUIRED`.

5. **Agent executes port** (see [agent loop spec](../arch/agent-loop.md))
    - Target repo is checked out; port branch is created.
    - Agent applies equivalent changes using source context + plugin config.
    - Validation commands run; on failure the agent iterates (read error → fix → rerun).
    - In the happy path, validations pass within the retry budget.

6. **PR is opened (or updated) in target repo**
    - On first run, a new PR is created. On re-runs where the port branch already has an open PR, the existing PR is updated with fresh output rather than failing.
    - PR title follows predictable format:
        - `Port: <source PR title>`
    - PR body follows a compact layout:
        - `## Cross-repo port` heading with decision blockquote immediately below (the "why" is the first thing a reviewer reads)
        - decision blockquote includes the model name and at-a-glance stats on the attribution line (e.g. `— claude-sonnet-4-6 (2 files changed · 1 attempt · 5 tool calls · 18.6s)`)
        - source narrative below the blockquote (`Ported from [<title>](<url>) in <repo>`)
        - `### What was ported` — the agent's per-file summary of changes (the main content)
        - collapsed `Agent Work Log` with assistant notes in italics and tool actions in code blocks (for retries, grouped by attempt)
        - collapsible `Validation & diagnostics` section with pass/fail results
        - `Ported by: Repo Port Bot` footer linking to the bot repository (loop prevention signal remains the git trailer `Ported-By: repo-port-bot`)

7. **Maintainer reviews a small, traceable PR**
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

2. **Traceability**
    - Target PR contains a link to source PR in the body and source PR title in the PR title.
    - For non-skipped outcomes (`pr_opened`, `draft_pr_opened`, `needs_human`, `failed`), source PR receives a bot comment linking to the target PR/issue or run status.
    - On reruns, newer non-failure comments can explicitly supersede prior failed comments (with link + run id) so maintainers can follow the latest state.

3. **Correctness gate**
    - Target PR is only marked "ready" when configured validation commands pass.

4. **Iteration behavior**
    - At least one validation failure can be auto-recovered in-run (fix + rerun) when within retry budget.

5. **Loop safety**
    - Bot-created port PR merges do not re-trigger an opposite-direction echo port.

6. **Fallback quality**
    - If retries are exhausted, bot opens a draft PR with `port-stalled` label and clear "where it got stuck" notes.
    - If the decision stage returns `NEEDS_HUMAN`, bot opens an issue tagged `needs-human` linking to the source PR.

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
    - `skipped_not_required` — heuristics or LLM determined no port needed
    - `needs_human` — decision stage deferred to a human; issue opened
    - `pr_opened` — port succeeded, validations pass, PR ready for review
    - `draft_pr_opened` — port attempted but validations failed after retries; draft PR with notes
    - `failed` — engine-level error (crash, timeout, API failure) prevented completion; best-effort cleanup

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

### Pivot template

- **Date**:
- **What changed**:
- **Why**:
- **Impact on success definition**:
- **Follow-up implementation tasks**:
