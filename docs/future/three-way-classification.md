# Three-Way LLM Classification

This note captures a likely next product step for the decision stage: upgrading the classifier from a binary result to a true three-way decision.

## Problem

At the engine level, runs can already end in three high-level decision outcomes:

- `PORT_REQUIRED`
- `PORT_NOT_REQUIRED`
- `NEEDS_HUMAN`

But the LLM classifier itself is still binary today:

- required
- not required

That distinction matters:

- The **engine** can already produce `NEEDS_HUMAN`
- The **classifier** cannot intentionally choose `needs_human` as its own output

That means the classifier cannot explicitly say:

"This change probably does need porting, but automation should stop here because confidence is low, mapping is ambiguous, or the change is too risky."

Today, `NEEDS_HUMAN` is mostly a fallback or orchestration-level outcome rather than a first-class classifier answer.

## Proposed capability

Upgrade the classifier output to something like:

```ts
{
	decision: 'required' | 'not_required' | 'needs_human'
	reason: string
}
```

The engine would then map those directly to:

- `required` -> `PORT_REQUIRED`
- `not_required` -> `PORT_NOT_REQUIRED`
- `needs_human` -> `NEEDS_HUMAN`

## Why this matters

This allows the bot to distinguish three very different states:

- "This change does not apply to the target repo."
- "This change should be ported automatically."
- "This change likely applies, but a human should review or finish it."

Without that third answer, hard real-world changes tend to get pushed into the wrong buckets:

- skipped when they should have been escalated
- attempted when they should have been intentionally handed off

## User value

This would make the user stories more powerful because `needs-human` becomes a deliberate product path, not just a crash fallback.

That improves:

- maintainer trust
- decision quality
- issue quality for hard ports
- the signal value of `needs-human` over time

It also creates a much better feedback loop: the team can inspect which `needs-human` issues were later manually ported vs dismissed and use that to tune classifier confidence.

## Likely follow-up

Once three-way classification exists, the next natural step is enriching the `needs-human` issue with a more useful manual-port starter kit:

- candidate target-file mapping
- what the classifier inspected
- why confidence was low
- suggested next step for the maintainer

## Open questions

- Should `needs_human` mean only "the bot is not confident this change applies to the target repo," or also "the change probably does apply, but the port looks too large or risky to automate safely"?
- Today, if the bot attempts a port and keeps failing validation, it eventually opens a draft/stalled PR. Should `needs_human` be used earlier for changes that already look too risky or ambiguous, or should the bot keep using the current "try first, then stall into a draft PR" behavior?
- How should the bot tell the difference between "this really does not need to be ported" and "I am too unsure to confidently skip this"?
