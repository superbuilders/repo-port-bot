# Needs Human: Escalation to Manual Port

This story covers the outcome where the engine determines that a source change cannot or should not be automatically ported, and escalates to a human via a follow-up issue.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what "good escalation" looks like. The maintainer should receive enough context in the issue to understand why the bot didn't attempt the port and what they need to do, without having to reverse-engineer the source diff or dig through logs.

## Primary actor

- SDK maintainer responsible for a paired repo setup.

## Trigger

- A pull request is merged into the source repository default branch.
- The decision stage returns `NEEDS_HUMAN` — the engine has determined it should not attempt automatic execution.

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

The classifier uses `needs_human` when a source change likely applies to the target repo but looks too risky, ambiguous, or complex for automation to handle safely.

This is distinct from `PORT_NOT_REQUIRED`, which means the change genuinely does not apply to the target repo. The difference matters because:

- `PORT_NOT_REQUIRED` ends the run with a skip comment. No issue, no action item.
- `NEEDS_HUMAN` opens or updates an issue in the target repo. The maintainer has something to act on.

### Engine failure fallback

If the pipeline crashes before producing a decision (e.g., GitHub API error, config resolution failure), the engine falls back to a `NEEDS_HUMAN` decision with a reason describing the failure. This ensures no source change is silently dropped -- even infrastructure failures produce a visible artifact.

### In all cases

Regardless of which path produces the `NEEDS_HUMAN` decision, no agent execution occurs. The bot does not touch the target repo's code.

## Narrative

1. **Maintainer merges source PR**
    - A normal feature/fix PR is merged in source repo.
    - Maintainer does not take any manual action.

2. **Engine runs through context, config, decision**
    - Workflow fires on push. Engine gathers source PR metadata, changed files, and diff. Plugin config is resolved. Decision stage returns `NEEDS_HUMAN`.

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
        - Why the bot decided not to attempt it.
        - How many files were involved.
    - They look at the source PR diff to assess the porting effort.

7. **Maintainer resolves the issue**
    - **Port manually**: create a branch in the target repo, apply the equivalent changes by hand, open a PR, and close the issue. The issue serves as the paper trail.
    - **Dismiss**: if the change genuinely doesn't need porting (classifier was wrong), close the issue with a note. This feedback is useful for tuning the classifier.
    - **Defer**: leave the issue open and come back to it later. The `needs-human` label makes deferred items filterable.

## User-visible definition of success

The maintainer experiences the escalation as "the bot told me it couldn't do this one and explained why":

- The issue appears shortly after source merge (under 10 minutes).
- The reason is specific enough to be actionable — not a generic "too complex" but something like "source change introduces a new public API surface that has no equivalent in the target repo."
- The issue body links directly to the source PR so the maintainer can jump to the diff immediately.
- The `needs-human` label lets the team track how often the bot escalates and whether the classifier is improving over time.

## Acceptance criteria

1. **Issue, not PR**
    - When the decision is `NEEDS_HUMAN`, the bot creates or updates an issue in the target repo. No branch is pushed, no PR is opened, no agent execution occurs.

2. **Idempotent issue reuse**
    - For the same source change, reruns reuse the same open `needs-human` issue instead of creating duplicates. The issue acts as the stable handoff artifact for human follow-up.

3. **Needs-human label**
    - The issue carries the `needs-human` label.

4. **Actionable body**
    - Issue body includes a link to the source PR, the decision reason, and the changed file count. A maintainer should be able to decide whether to port immediately, defer, or dismiss without opening any other page.

5. **Source notification**
    - Source PR receives a comment linking to the issue plus decision-stage cost and input/output token totals. The maintainer who merged the source PR gets notified through GitHub's existing subscription model.

6. **No side effects**
    - No target repo code is modified. No branch exists. If the maintainer dismisses the issue, the target repo is exactly as it was before.

## When this outcome is most likely

- The source change is a large refactor or architecture shift that doesn't map cleanly to the target repo's structure (new module patterns, renamed abstractions, fundamental API changes).
- The source and target repos use different languages or frameworks, and the change involves idioms that don't translate directly.
- The classifier inspects both repos and determines its confidence is too low to attempt an automated port.
- The engine encountered an infrastructure failure (API timeout, auth error, malformed config) before it could make a real decision. The `NEEDS_HUMAN` fallback ensures nothing is silently dropped.

## Non-goals

- Providing a partial port or suggested diff in the issue. If the bot can't confidently execute, it shouldn't guess.
- Automatically re-running when the issue is closed. The maintainer decides whether to port and how.
- Distinguishing between "classifier said needs-human" and "engine failed" in the issue body. Both produce the same issue format; the reason field explains which case it is.
