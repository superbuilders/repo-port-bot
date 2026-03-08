# Three-Way LLM Classification

How the decision stage classifies source changes into `PORT_REQUIRED`, `PORT_NOT_REQUIRED`, or `NEEDS_HUMAN`.

## Purpose

The decision stage has two jobs:

1. determine whether a source change applies to the target repo
2. determine whether automation should proceed or hand off to a maintainer

Three-way classification gives the LLM path a first-class way to express all three high-level decision outcomes the engine understands.

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

- `PORT_REQUIRED` — the source change applies to the target repo and the bot should attempt an automated port.
- `PORT_NOT_REQUIRED` — the source change does not meaningfully apply to the target repo and the run should end with a skip.
- `NEEDS_HUMAN` — the source change likely does apply to the target repo, but the bot should stop before execution because confidence is too low or the change appears too risky, ambiguous, or complex to automate safely.

## Relationship to heuristics and fallbacks

Three-way classification does **not** mean every decision goes through the LLM. The decision stage runs in this order:

1. fast heuristics
2. provider-backed classifier
3. engine fallback

### Heuristics

Heuristics return only `PORT_REQUIRED` or `PORT_NOT_REQUIRED`. They handle obvious cases quickly: missing PR context, loop prevention, labels, docs-only changes, and config-only changes.

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

- `PORT_REQUIRED` -> execution begins, then delivery opens or updates a target PR
- `PORT_NOT_REQUIRED` -> source PR gets a skip comment, no target-side artifact
- `NEEDS_HUMAN` -> execution is skipped and delivery opens a `needs-human` issue

## Likely follow-up

A natural follow-up is to enrich the `needs-human` issue with a better manual handoff payload, for example:

- candidate target-file mapping
- what the classifier inspected
- why confidence was low
- suggested next step for the maintainer

## Open questions

- Should `needs_human` mean only "the bot is not confident this change applies to the target repo," or also "the change probably does apply, but the port looks too large or risky to automate safely"?
- If the bot attempts a port and keeps failing validation, it opens a draft/stalled PR. Should `needs_human` be used earlier for changes that already look too risky or ambiguous, or should the bot keep using the current "try first, then stall into a draft PR" behavior?
- How should the bot tell the difference between "this really does not need to be ported" and "I am too unsure to confidently skip this"?
