# Deterministic + Agent Phases

This note captures the intended future product shape for combining:

1. deterministic operations the engine can apply safely, and
2. agent-authored residual work that still benefits from model judgment

## Relationship to `docs/arch/state-machine.md`

The canonical run-state and artifact-selection logic now lives in:

- [`docs/arch/state-machine.md`](../arch/state-machine.md)

This future doc does **not** redefine the state machine.

Instead, it focuses on:

- why the product should have two phases
- what each phase is responsible for
- what context the agent should receive
- how resulting PRs should be framed for reviewers
- the remaining product questions after the state machine is fixed

## Problem

Today the product tends to treat the whole port as one automation decision:

- either skip / hand off before execution, or
- run the agent against the full change

That is too coarse for repo pairs where a single source change contains both:

- boring but necessary mechanical work, and
- target-specific work that may still require agent reasoning or human judgment

Example:

- mirror `tests/fixtures/**`
- copy `tests/manifest.json`
- then decide whether any target-specific test or API updates are still needed

The goal is not "make the agent do less because it is weak."

The goal is:

- guarantee deterministic work without requiring model confidence
- shrink the residual problem the agent must solve
- preserve useful target-side progress even when the residual work is skipped, escalated, or stalled

## Phase model

### Phase 1: deterministic operations

Phase 1 is engine-applied.

It should be:

- declarative
- validated
- independently safe to merge on its own
- boring on purpose

The deterministic phase is designed to support multiple operation kinds over time. Each kind is:

- a tagged variant in a `DeterministicOperation` union
- dispatched by the engine executor
- declared in its own config section of `port-bot.json`

Current operation kinds:

- **sync** — file-level mirror and copy (`sync` config key)

Future candidates:

- simple source-to-target path remaps
- content-level find-and-replace
- structured transforms (e.g., rename exports)

Phase 1 is **not** a place for arbitrary shell commands or custom repo scripting.

If a transformation is not safe, predictable, and engine-owned, it does not belong here.

This preserves the current safety model:

- repo config remains validated data
- the engine owns execution semantics
- maintainers get predictable behavior instead of repo-specific scripting

The guardrail from `docs/user-stories/anchor.md` still holds:

- No execution of arbitrary code from repo configuration.
- Plugin/config only influences behavior through validated declarative inputs.

### Config shape

Each deterministic operation kind gets its own top-level key in `port-bot.json`. The engine collects entries from all keys into a single ordered `deterministicOperations` list in `PluginConfig`.

Currently the only implemented key is `sync`:

```json
{
	"target": "superbuilders/timeback-dev-python",
	"sync": [
		{
			"source": "tests/fixtures/**",
			"target": "tests/fixtures/",
			"mode": "mirror"
		},
		{
			"source": "tests/manifest.json",
			"target": "tests/manifest.json",
			"mode": "copy"
		}
	],
	"validation": ["just check-ci"],
	"mapping": {
		"packages/clients/caliper/": "packages/caliper/"
	},
	"ignore": [".github/**", "tests/fixtures/**", "tests/manifest.json"],
	"conventions": {
		"naming": "camelCase -> snake_case"
	},
	"prompt": "..."
}
```

Semantics:

- `mode: "mirror"` — recursive copy with delete (like `rsync --delete`). Removed source files are removed from the target.
- `mode: "copy"` — overwrite a single target file from a single source file.
- `sync` entries reference source-repo paths and target-repo paths.
- `sync` entries are processed in order.
- Paths listed in `sync` should typically also appear in `ignore` so the agent does not re-port them independently.

### Motivating example

The repo pair `timeback-dev` -> `timeback-dev-python` currently uses a separate GitHub Actions workflow (`sync-fixtures-to-python.yml`) to copy `tests/fixtures/**` and `tests/manifest.json` into the Python repo on every push to `dev`.

That workflow exists because:

- fixture files are language-neutral JSON and should be byte-identical across repos
- the port bot's `port-bot.json` already lists those paths in `ignore` so the agent does not try to port them
- but the agent's `NEEDS_HUMAN` or `NO_AGENT_PORT_NEEDED` decisions should not block fixture delivery

With the proposed `sync` config, the separate workflow can be retired. The engine handles fixture mirroring as a deterministic operation, and the resulting changes flow through the normal state machine.

### Phase 2: residual classification + agent execution

After deterministic operations are applied, the system should:

1. classify the residual work
2. only run the agent if the port decision is `PORT_REQUIRED`

This means the classifier is no longer answering:

- "Should there be any target-side artifact at all?"

It is answering:

- "What should happen to the remaining work after deterministic changes are already in place?"

That distinction is the key simplification behind the new state machine.

## Why phase 1 comes first

Deterministic operations should run before classification because that keeps the logic simple:

- classification only reasons about residual work
- deterministic work can still produce a valid PR on its own
- `NO_AGENT_PORT_NEEDED` and `NEEDS_HUMAN` stop meaning "no target artifact" by default
- the system no longer needs special exceptions to explain why a PR still opened

If deterministic operations were delayed until after classification, the product would immediately reintroduce confusing edge cases around artifact selection.

## Agent context requirements

When phase 2 runs, the agent should receive explicit context about the deterministic baseline.

Minimum useful context:

- summary of deterministic operations that ran
- files touched by phase 1
- resulting patch or diff from phase 1
- explicit instruction that these changes are authoritative baseline work, not noise to casually revert

That lets the agent reason from the actual prepared target tree instead of rediscovering or accidentally undoing work the engine already completed safely.

## Reviewer-facing PR framing

The state machine determines the artifact.

Reviewer framing determines how that artifact should be explained.

The main framing modes are:

- `Deterministic-only`
    - PR exists because deterministic operations produced the necessary target-side changes
    - no agent-authored edits are included
- `Residual handoff`
    - PR exists because deterministic operations produced the necessary target-side changes
    - residual work was classified as requiring human judgment before agent execution
- `Normal success`
    - agent ran and validations passed
- `Draft / stalled`
    - agent ran and validations failed, so preserved progress lives in a draft PR
- `Validated but incomplete`
    - agent ran, validations passed, but the agent reported that it did not finish confidently

The canonical artifact flow for these cases is documented in `docs/arch/state-machine.md`.

This doc’s contribution is the reviewer expectation:

- deterministic work should be visible, but usually visually secondary
- if no agent edits exist, the PR should say so plainly
- if residual work still needs human judgment, the PR should make the remaining work crisp and obvious
- if the agent ran but left uncertainty, the PR body should surface that uncertainty even when validations pass

## PR body templates

These templates show how each framing mode should read to a reviewer.

### Template A: deterministic only

Corresponds to: `deterministic_changed=yes`, residual `NO_AGENT_PORT_NEEDED`, no agent execution.

```md
## Port rationale

> Deterministic operations configured for this repo pair produced target-side changes, and no additional agent-authored edits were required.

Ported from [<source PR title>](url) (originally authored by @author) in [`<owner>/<repo>`](<repo url>). This port updated 2 files over 4.1s using deterministic operations only, with no agent-authored edits.

## What changed

No agent execution was required.

<details><summary>Work Log</summary>

_This port was completed through deterministic operations only._

Mirrored:

- `tests/fixtures/**` -> `tests/fixtures/`

Copied:

- `tests/manifest.json` -> `tests/manifest.json`

Updated:

- `tests/fixtures/foo/bar.json`, `tests/manifest.json`

</details>

---

Ported by: [Repo Port Bot](<bot repo url>)
```

### Template B: deterministic + agent success

Corresponds to: `deterministic_changed=yes`, residual `PORT_REQUIRED`, agent succeeds, validations pass.

```md
## Port rationale

> <decision reason as blockquote>

Ported from [<source PR title>](url) (originally authored by @author) in [`<owner>/<repo>`](<repo url>). This port updated 5 files over 19.8s and was completed by [claude-sonnet-4-6](https://models.dev/?search=claude-sonnet-4-6) in 1 attempt, after 2 deterministic operations were applied successfully.

## What was ported

Once the deterministic changes were in place, the agent ported the remaining behavior.

- `packages/caliper/src/...`: Ported the new event builder shape and adjusted Python-side typing to match the source SDK behavior.
- `packages/caliper/tests/...`: Added the corresponding Python tests for the new behavior.

<details><summary>Deterministic baseline (2 operations)</summary>

Mirrored:

- `tests/fixtures/**` -> `tests/fixtures/`

Copied:

- `tests/manifest.json` -> `tests/manifest.json`

Updated:

- `tests/fixtures/foo/bar.json`, `tests/manifest.json`

</details>

<details><summary>Work Log</summary>
_I'll start from the deterministic baseline already applied in the target repo, then port the remaining Python-specific changes._
```

Read port-diff.patch
Read packages/caliper/src/...
Edited packages/caliper/src/...
Edited packages/caliper/tests/...

```

</details>

<details><summary>Validation & diagnostics</summary>

- [PASS] `just check-ci` (exit code 0)

```

All checks passed.

```

</details>

---

Ported by: [Repo Port Bot](<bot repo url>)
```

### Template C: deterministic + residual needs human

Corresponds to: `deterministic_changed=yes`, residual `NEEDS_HUMAN`, no agent execution.

```md
## Port rationale

> Deterministic operations produced safe side-effects. The remaining port requires human judgment, so this PR preserves the deterministic changes and leaves the residual work for follow-up.

Ported from [<source PR title>](url) (originally authored by @author) in [`<owner>/<repo>`](<repo url>). This PR preserves 2 deterministic operations. No agent-authored edits are included.

## What is already done

The deterministic portion of this port has already been applied and is ready for review:

- Mirrored `tests/fixtures/**` -> `tests/fixtures/`
- Copied `tests/manifest.json` -> `tests/manifest.json`

## What still needs human review

The residual port was classified as requiring human judgment before agent execution:

- `packages/caliper/src/...`: target API shape differs from the source change and needs a maintainer decision
- `packages/caliper/tests/...`: test expectations likely need adjustment after the API decision

<details><summary>Work Log</summary>

_This port was completed through deterministic operations only. Residual work was classified as requiring human judgment before agent execution._

Mirrored:

- `tests/fixtures/**` -> `tests/fixtures/`

Copied:

- `tests/manifest.json` -> `tests/manifest.json`

Updated:

- `tests/fixtures/foo/bar.json`, `tests/manifest.json`

</details>

---

Ported by: [Repo Port Bot](<bot repo url>)
```

### Template D: deterministic + agent handoff

Corresponds to: `deterministic_changed=yes`, residual `PORT_REQUIRED`, agent starts editing but validations fail after retries.

```md
## Port rationale

> Deterministic operations produced safe side-effects, and the agent began the remaining port, but execution did not complete successfully.

Ported from [<source PR title>](url) (originally authored by @author) in [`<owner>/<repo>`](<repo url>). This draft PR preserves 2 deterministic operations and the agent's best attempt at the remaining port.

## What is already done

The deterministic portion of this port has already been applied and is ready for review:

- Mirrored `tests/fixtures/**` -> `tests/fixtures/`
- Copied `tests/manifest.json` -> `tests/manifest.json`

## What still needs human review

The agent could not finish the residual portion safely.

- `packages/caliper/src/...`: target API shape differs from the source change and needs a maintainer decision
- `packages/caliper/tests/...`: test expectations likely need adjustment after the API decision

<details><summary>Agent notes</summary>

_I preserved the deterministic changes and attempted the Python port, but confidence is low around the target-side API mapping. I did not want to guess on the final shape._

</details>

<details open><summary>Validation & diagnostics</summary>

- [PASS] `just check-manifest` (exit code 0)
```

Manifest OK: 758 fixtures across 12 resources.

```

- [FAIL] `just check-ci` (exit code 1)

```

FAILED tests/caliper/test_event_builder.py::test_new_shape - TypeError: missing required argument 'event_type'
FAILED tests/caliper/test_event_builder.py::test_typed_builder - AssertionError: expected Caliper event
2 failed, 847 passed

```

- Final status: validation failed after retries.
- Failure reason: Python type and test failures remain in the target-specific ported files.

</details>

---

Ported by: [Repo Port Bot](<bot repo url>)
```

## Rendering principles

- Use `Work Log` consistently across PR types.
- Deterministic-only `Work Log` content should be compact and engine-generated, not fake agent narration.
- When deterministic work and agent work both exist, foreground the interesting agent-authored delta and relegate deterministic detail to a compact section.
- When deterministic work exists but residual work needs human review, make it explicit that the PR contains deterministic progress only.
- Validation should continue to control `ready` vs `draft`.
- PR framing should not pretend that validation alone proves semantic completeness.

## Product boundaries

This proposal assumes:

- deterministic operations can be trusted to stand on their own
- artifact selection is governed by the canonical state machine
- PR framing can express more nuance than the artifact state alone

This proposal does **not** assume:

- that all residual work is agent-safe
- that passing validations proves the port is semantically complete
- that every future framing mode must become a distinct artifact state

## Open product question

The main remaining question is:

- what reviewer-facing treatment should we use for `validated but incomplete`?

Meaning:

- the agent ran
- validations passed
- but the agent reported it did not complete confidently

The current state machine intentionally treats this as a framing question, not an artifact-selection question.

That keeps the canonical state machine simple while still leaving room for a more nuanced PR body if the product wants it.
