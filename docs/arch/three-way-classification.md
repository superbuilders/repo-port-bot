# Three-Way LLM Classification

How the decision stage classifies residual work into `PORT_REQUIRED`, `PORT_NOT_REQUIRED`, or `NEEDS_HUMAN`.

## Purpose

The decision stage has two jobs:

1. determine whether the residual work (after deterministic operations) applies to the target repo
2. determine whether automation should proceed or hand off to a maintainer

Three-way classification gives the LLM path a first-class way to express all three high-level decision outcomes the engine understands.

Classification evaluates the **residual** work only. Deterministic operations have already been applied to the target working tree before classification runs. See [`docs/arch/state-machine.md`](state-machine.md) for how classification outcomes combine with deterministic changes to produce artifacts.

## Decision model

The decision stage can end in three outcomes:

- `PORT_REQUIRED`
- `PORT_NOT_REQUIRED`
- `NEEDS_HUMAN`

The classifier exposes those same semantics directly rather than collapsing everything into a binary required/not-required result.

### Classifier output contract

The LLM classifier returns:

```ts
{
	decision: 'required' | 'not_required' | 'needs_human'
	reason: string
}
```

The engine maps those values to `PortDecisionKind`:

- `required` -> `PORT_REQUIRED`
- `not_required` -> `PORT_NOT_REQUIRED`
- `needs_human` -> `NEEDS_HUMAN`

### Meaning of each outcome

- `PORT_REQUIRED` — the residual work applies to the target repo and the bot should attempt an automated port on top of the deterministic baseline.
- `PORT_NOT_REQUIRED` — the residual work does not meaningfully apply to the target repo.
- `NEEDS_HUMAN` — the residual work likely does apply to the target repo, but the bot should stop before execution because confidence is too low or the change appears too risky, ambiguous, or complex to automate safely.

These outcomes govern only the **residual** work. They do not determine whether any PR exists. When deterministic operations have already produced target-side changes, a PR may still be opened regardless of the port decision.

## Relationship to heuristics and fallbacks

Three-way classification does **not** mean every decision goes through the LLM. The decision stage runs in this order:

1. fast heuristics
2. provider-backed classifier
3. engine fallback

### Heuristics

Heuristics return only `PORT_REQUIRED` or `PORT_NOT_REQUIRED`. Some run before deterministic operations as pre-deterministic skip signals (missing PR context, `auto-port` loop prevention, `no-port` label) and suppress the entire run before any target mutation. The remaining heuristics run during the decision stage after deterministic operations: docs-only changes, config-only changes, and no remaining files after ignore filtering.

### Classifier

The classifier has the full three-way decision surface. It can intentionally escalate to `NEEDS_HUMAN` without pretending the change is safe to skip and without forcing the system into execution first.

### Fallbacks

If the pipeline crashes before a real decision is produced, the engine generates a fallback `NEEDS_HUMAN` decision so that failures are visible and no source change is silently dropped.

## Why this architecture matters

This lets the system distinguish three genuinely different states:

- "this does not need porting"
- "this should be ported automatically"
- "this probably needs porting, but a maintainer should take over"

Without this distinction, hard changes tend to end up in the wrong bucket: skipped when they should have been escalated, or attempted when they should have been intentionally handed off. With a first-class classifier `NEEDS_HUMAN` outcome, escalation is part of the normal product flow rather than only a crash or retry-exhaustion side effect.

## Observability

Classifier-produced `NEEDS_HUMAN` decisions use the same trace shape as other classifier decisions:

- `trace.source = 'classifier'`
- `trace.model`
- `trace.toolCallLog`
- `trace.events`
- `trace.notes`

The job summary, logs, and artifacts can all distinguish heuristic skip, classifier skip, classifier escalation, and fallback escalation.

## Product effect

The classifier outcome combines with the deterministic phase to determine the final artifact. The full logic is in [`docs/arch/state-machine.md`](state-machine.md). In summary:

- `PORT_REQUIRED` -> agent execution begins on top of the deterministic baseline, then delivery opens or updates a target PR
- `PORT_NOT_REQUIRED` + no deterministic changes -> source PR gets a skip comment, no target-side artifact
- `PORT_NOT_REQUIRED` + deterministic changes exist -> delivery opens or updates a ready PR containing the deterministic changes only
- `NEEDS_HUMAN` + no deterministic changes -> execution is skipped and delivery opens a `needs-human` issue
- `NEEDS_HUMAN` + deterministic changes exist -> execution is skipped and delivery opens a ready PR containing the deterministic changes, with a residual handoff note

## Open questions

- How should the bot tell the difference between "this really does not need to be ported" and "I am too unsure to confidently skip this"?
