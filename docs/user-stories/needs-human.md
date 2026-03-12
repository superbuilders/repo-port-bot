# Needs Human: Escalation to Manual Port

This story covers the outcome where the engine determines that the residual work (after deterministic operations) cannot or should not be automatically ported, and escalates to a human.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what "good escalation" looks like. The maintainer should receive enough context to understand why the bot didn't attempt the residual port and what they need to do, without having to reverse-engineer the source diff or dig through logs.

The artifact type depends on whether deterministic operations produced target-side changes:

- **No deterministic changes**: issue-only escalation (the current behavior).
- **Deterministic changes exist**: a ready PR containing the deterministic changes, with an explicit residual handoff note explaining what still needs human judgment.

See [`docs/arch/state-machine.md`](../arch/state-machine.md) for the canonical artifact-selection logic.

## Primary actor

- SDK maintainer responsible for a paired repo setup.

## Trigger

- A pull request is merged into the source repository default branch.
- Deterministic operations are applied (if configured). They may or may not produce target-side changes.
- The residual classification returns `NEEDS_HUMAN` — the engine has determined it should not attempt automatic execution of the remaining work.

## Preconditions

- Port bot workflow is installed in the source repo.
- Required secrets are configured.
- Repo pairing config exists.
- Loop prevention signals are enabled.

## How the decision is reached

`NEEDS_HUMAN` comes from two paths:

1. Classifier escalation, and
2. Engine failure fallback

### Classifier escalation

The LLM classifier returns a three-way output: `{ decision: 'required' | 'not_required' | 'needs_human', reason: string }`. When it returns `needs_human`, the engine maps that to `NEEDS_HUMAN` and skips execution entirely.

The classifier uses `needs_human` when the residual work likely applies to the target repo but looks too risky, ambiguous, or complex for automation to handle safely.

This is distinct from `PORT_NOT_REQUIRED`, which means the residual work genuinely does not apply to the target repo. The difference matters because:

- `PORT_NOT_REQUIRED` ends the residual work with a skip. If deterministic changes exist, a PR is still opened; otherwise, a skip comment is posted.
- `NEEDS_HUMAN` escalates the residual work to a human. If deterministic changes exist, a PR is opened with a residual handoff note; otherwise, an issue is opened.

### Engine failure fallback

If the pipeline crashes before producing a decision (e.g., GitHub API error, config resolution failure), the engine falls back to a `NEEDS_HUMAN` decision with a reason describing the failure. This ensures no source change is silently dropped -- even infrastructure failures produce a visible artifact.

### In all cases

Regardless of which path produces the `NEEDS_HUMAN` decision, no agent execution occurs for the residual work. The agent is not invoked.

However, deterministic operations may have already been applied before classification. If those operations produced target-side changes, a PR is opened to preserve them.

## Narrative A: no deterministic changes

This is the issue-only path. It applies when `phase1_changed = no`.

1. **Maintainer merges source PR**
    - A normal feature/fix PR is merged in source repo.
    - Maintainer does not take any manual action.

2. **Engine runs through context, config, deterministic operations, classification**
    - Workflow fires on push. Engine gathers source PR metadata, changed files, and diff. Plugin config is resolved. Deterministic operations are applied but produce no target-side changes. Residual classification returns `NEEDS_HUMAN`.

3. **No execution**
    - The engine skips the execution stage entirely. No agent is invoked, no edits are attempted, no target branch is created.

4. **Issue is opened (or updated) in target repo**
    - A follow-up issue is created in the target repository.
    - On reruns for the same source change, the maintainer should see the same open `needs-human` issue updated with fresh context rather than a new duplicate issue.
    - Issue title: `Needs review: <source PR title>` (truncated if long).
    - Issue label: `needs-human`.
    - Issue body includes:
        - Opening sentence linking to the source PR and `@`-mentioning the original author in a parenthetical attribution: "[title](url) (originally authored by @author) was merged in `source-repo` but could not be automatically ported."
        - **Why**: the classifier's or engine's reason for the decision.
        - **Changed files**: count of files in the source change.
    - No branch is pushed. No PR is created.

5. **Source PR receives a notification comment**
    - Best-effort comment on the merged source PR: "Could not automatically port to `target-repo`. Opened an issue: `<url>` for manual review."
    - The comment includes a collapsible reason plus a collapsed `Cost & Tokens` block with the decision-stage totals, since no execution run occurred.
    - This is how the maintainer discovers the escalation.

6. **Maintainer triages the issue**
    - Maintainer clicks through from the source PR comment (or finds the issue in the target repo via the `needs-human` label).
    - They read the issue body to understand:
        - What was merged in the source repo.
        - Why the bot decided not to attempt the residual work.
        - How many files were involved.
    - They look at the source PR diff to assess the porting effort.

7. **Maintainer resolves the issue**
    - **Port manually**: create a branch in the target repo, apply the equivalent changes by hand, open a PR, and close the issue. The issue serves as the paper trail.
    - **Dismiss**: if the change genuinely doesn't need porting (classifier was wrong), close the issue with a note. This feedback is useful for tuning the classifier.
    - **Defer**: leave the issue open and come back to it later. The `needs-human` label makes deferred items filterable.

## Narrative B: deterministic changes exist

This is the PR path. It applies when `phase1_changed = yes`.

1. **Maintainer merges source PR**
    - A normal feature/fix PR is merged in source repo.
    - Maintainer does not take any manual action.

2. **Engine runs through context, config, deterministic operations, classification**
    - Workflow fires on push. Engine gathers source PR metadata, changed files, and diff. Plugin config is resolved. Deterministic operations are applied and produce target-side changes. Residual classification returns `NEEDS_HUMAN`.

3. **No agent execution**
    - The engine skips the agent execution stage entirely. Deterministic changes are already in the target working tree.

4. **PR is opened (or updated) in target repo**
    - A ready PR is created containing the deterministic changes.
    - On reruns for the same source change, the same port branch and PR are reused.
    - PR body includes:
        - `## Port rationale` explaining that deterministic operations produced safe side-effects and the residual work requires human judgment.
        - `## What is already done` listing the deterministic operations applied.
        - `## What still needs human review` describing the residual work the classifier deferred.
        - `Work Log` with compact engine-generated content (no agent narration).
    - No `needs-human` issue is opened. The PR replaces the issue as the handoff artifact because deterministic changes need a reviewable target-side artifact.

5. **Source PR receives a notification comment**
    - Best-effort comment on the merged source PR linking to the target PR.
    - The comment explains that deterministic changes were applied and the residual work needs human follow-up.

6. **Maintainer triages the PR**
    - Maintainer sees the deterministic changes are already applied and reviewable.
    - The PR body makes explicit what residual work still needs human attention.
    - The maintainer can merge the deterministic portion and address the residual work separately, or push additional commits onto the branch to complete the full port.

## User-visible definition of success

The maintainer experiences the escalation as "the bot told me it couldn't do this one and explained why":

- The issue appears shortly after source merge (under 10 minutes).
- The reason is specific enough to be actionable — not a generic "too complex" but something like "source change introduces a new public API surface that has no equivalent in the target repo."
- The issue body links directly to the source PR so the maintainer can jump to the diff immediately.
- The `needs-human` label lets the team track how often the bot escalates and whether the classifier is improving over time.

## Acceptance criteria

1. **Artifact depends on deterministic changes**
    - When `NEEDS_HUMAN` and no deterministic changes exist: issue in the target repo, no branch, no PR, no agent execution.
    - When `NEEDS_HUMAN` and deterministic changes exist: ready PR in the target repo containing the deterministic changes, with a residual handoff note. No issue is opened.

2. **Idempotent artifact reuse**
    - For the issue path: reruns reuse the same open `needs-human` issue instead of creating duplicates.
    - For the PR path: reruns reuse the same port branch and PR instead of creating duplicates.

3. **Labels**
    - Issue path: `needs-human` label on the issue.
    - PR path: `auto-port` label on the PR.

4. **Actionable body**
    - Issue body includes a link to the source PR, the decision reason, and the changed file count.
    - PR body includes deterministic changes applied, the residual handoff note, and a link to the source PR. A maintainer should be able to understand what is done and what remains without opening any other page.

5. **Source notification**
    - Source PR receives a comment linking to the issue or PR. The maintainer who merged the source PR gets notified through GitHub's existing subscription model.

6. **No side effects beyond declared artifacts**
    - Issue path: no target repo code is modified. No branch exists.
    - PR path: only deterministic changes are committed. No agent-authored edits exist.

## When this outcome is most likely

- The source change is a large refactor or architecture shift that doesn't map cleanly to the target repo's structure (new module patterns, renamed abstractions, fundamental API changes).
- The source and target repos use different languages or frameworks, and the change involves idioms that don't translate directly.
- The classifier inspects both repos and determines its confidence is too low to attempt an automated port.
- The engine encountered an infrastructure failure (API timeout, auth error, malformed config) before it could make a real decision. The `NEEDS_HUMAN` fallback ensures nothing is silently dropped.

## Non-goals

- Providing agent-authored partial edits when the port decision is `NEEDS_HUMAN`. If the bot can't confidently execute the residual work, it should not attempt it. Deterministic changes are safe by definition; agent guesses are not.
- Automatically re-running when the issue is closed or the PR is merged. The maintainer decides whether to port the residual work and how.
- Distinguishing between "classifier said needs-human" and "engine failed" in the issue/PR body. Both produce the same format; the reason field explains which case it is.
