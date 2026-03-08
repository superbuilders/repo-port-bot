# Maintainer Intervention

This note captures the next likely product step after v1 observability: giving maintainers a first-class way to intervene when a run stalls, misclassifies, or needs another attempt.

## Problem

Today the bot is strong at explaining what happened:

- source PR comment
- target PR or needs-human issue
- GitHub Actions summary
- structured logs
- downloadable artifacts

But the product is still weak at helping a maintainer do the next thing from those surfaces.

Examples:

- "Retry this source PR now that I fixed `port-bot.json`."
- "Run the port again after I changed the target repo."
- "Try again with more attempts or debug logging."

The engine already has most of the technical primitives needed for safe retries:

- deterministic port branches
- force-push to bot-owned branches
- PR upsert instead of duplicate PR creation
- superseding source comments
- stalled label cleanup on success

So the missing piece is mostly a product surface, not a core engine primitive.

## Proposed capability

Add a maintainer-invoked rerun / replay flow.

Possible surfaces:

- `workflow_dispatch` with explicit source PR or merge SHA input
- future PR comment command (for example, "/repo-port-bot retry")

## User value

This would turn the current UX from:

1. inspect what happened
2. infer the next manual step
3. re-trigger indirectly

into:

1. inspect what happened
2. make a small fix or decision
3. explicitly rerun the port from a supported surface

That makes the user stories more powerful because maintainers gain a true control loop instead of just better diagnostics.

## Scope ideas

Minimum useful version:

- rerun a specific source PR
- reuse the same deterministic port branch
- update the same target PR when it already exists
- update the same open `needs-human` issue when the rerun still ends in `NEEDS_HUMAN`
- preserve current source comment supersede behavior

Possible follow-ups:

- rerun with debug logging
- rerun with custom max attempts
- rerun after config override
- rerun from latest source PR head vs original merge SHA

## Open questions

- Should reruns always target the original merge commit, or optionally the latest source PR head?
- Should manual reruns be source-repo-only (`workflow_dispatch`) or also comment-driven?
- How should reruns interact with concurrently running push-triggered jobs?
