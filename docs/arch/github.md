# GitHub & Git Operations

All GitHub API interactions and git operations the engine performs. Covers reading source context, writing to the target repo, and the workflow/action surface area.

## Reads (source repo)

These happen early in the pipeline to build `PortContext` and prepare agent inputs.

### Source clone

The source repo is shallow-cloned at the merge commit SHA into a temp directory.
This gives the agent direct disk access to source files for exploratory reads (imports,
tests, adjacent context) and provides a reliable way to compute the full diff locally.

### PR metadata

- PR number, title, body, URL
- Labels (needed for `no-port` / `auto-port` detection)
- Author login (used in the target PR provenance sentence to `@`-mention the original author, triggering a GitHub notification)
- Merge commit SHA

Source: GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{pull_number}`)

### Diff and changed files

- File paths, statuses (added/modified/deleted/renamed), additions/deletions counts
- Full diff computed locally via `git diff HEAD~1` in the source clone, saved to `port-diff.patch`

The per-file `patch` field from the GitHub list-files API is still used by decision-stage
heuristics (docs-only, config-only) but the agent prompt uses the locally-computed diff
file instead — no truncation, no missing patches.

Files matching `ignorePatterns` from `port-bot.json` are filtered from the changed-file list
and stripped from the diff file before the decision and execution stages see them. The agent's
system prompt also lists the ignore patterns so it won't treat missing ignored files as gaps
to fill during exploration. When all files are filtered, the `checkNoRemainingFiles` heuristic
returns `NO_AGENT_PORT_NEEDED`.

Source: GitHub REST API for file list + stats; `git diff` from source clone for diff content.

### Source config file (optional)

The engine looks for a supported config filename at the merged commit SHA in this precedence order:

1. `port-bot.json`
2. `.port-bot.json`
3. `repo-port-bot.json`
4. `.repo-port-bot.json`
5. `.github/port-bot.json`
6. `.github/repo-port-bot.json`

- 404 is not an error — the config file is optional; other fetch failures warn but don't fail the run
- Parsed via `port-bot-json.decoder.ts` (runtime validation with `decoders.cc`)
- Merged with built-in config (action inputs take precedence, config file fills gaps)
- `runPort()` auto-fetches when the caller doesn't provide `portBotJson` externally
- Action input `skip-port-bot-json: true` disables config-file fetching for faster runs

## Writes (target repo)

These happen after deterministic operations and (optionally) agent execution have been applied to the target working tree. The full artifact-selection logic is in [`state-machine.md`](state-machine.md).

### Delivery diff scoping

Before creating a branch or PR, the engine checks whether the target working tree actually has deliverable changes. The scope of this check depends on the delivery path:

- **Deterministic-only** (`NO_AGENT_PORT_NEEDED` or `NEEDS_HUMAN` with deterministic changes): the diff check and staging are scoped to the specific paths reported as touched by deterministic operations. This prevents unrelated files (validation artifacts, coverage output) from leaking into the PR.
- **Agent execution** (`PORT_REQUIRED`): the diff check is skipped entirely. The engine always attempts delivery because the agent may have created files via `Bash` that are not tracked in `execution.outcome.touchedFiles`. Staging uses `git add -A` to capture all working-tree changes. The internal `git diff --cached --quiet` check after staging still prevents empty commits.

### Branch creation and push

- Branch naming: `port/<sourceRepo>/<sourcePrNumber>-<shortSha>`
- Force-push the port branch to the target repo remote. The branch is bot-owned (deterministic naming), so force-push is safe and makes re-runs idempotent — fresh agent output replaces any previous attempt on the same branch.

**Commit message** uses the PR title with git trailers for machine-parseable auditing:

```
Port: Add formatting/date helpers

Source-PR: https://github.com/acme/source-repo/pull/1
Source-Commit: 9d67a0487cd618b92aea581294cebf26bf770484
Agent-Model: claude-sonnet-4-6
Ported-By: repo-port-bot
```

- `Source-PR` is included when the source change came from a merged PR
- `Source-Commit` is always present (the merge commit SHA)
- `Agent-Model` is included when the provider reports its model
- `Ported-By` serves as both attribution and loop prevention signal

Auth: `github-token` (single-token mode) or `target-github-token` (split-token mode).

### Pull request creation (upsert)

On first run, a new PR is created. On re-runs where the port branch already has an open PR (from a previous attempt), the engine finds the existing PR and updates its title and body instead of failing. This means re-triggering a workflow produces an updated PR rather than an error.

**Title format:**

```
Port: <source PR title>
```

**Body layout:**

```md
## Port rationale

> <decision reason as blockquote>

Ported from [<source PR title>](url) (originally authored by @author) in [`<owner>/<repo>`](<repo url>). This port updated 2 files over 18.6s and was completed by [claude-sonnet-4-6](https://models.dev/?search=claude-sonnet-4-6) in a single attempt, using 5 tool calls.

<details><summary>Cost & Tokens</summary>

- Decision: $0.12, 2.5k tokens
- Execution: $1.34, 18.9k tokens across 2 attempts
- Total: $1.46, 21.4k tokens

</details>

## What was ported

<agent summary overview>

- `<path>`: <per-file description>

<details><summary>Work Log</summary>
_I'll start by reading the source diff and target files._
```

Read port-diff.patch
Read src/date.ts

```

_The target file matches the pre-patch state. I'll apply the addition now._


```

Edited src/date.ts
Ran `bun run check` (18.6s)

```

_Both changes have been applied successfully._

</details>

<details><summary>Validation & diagnostics</summary>

- [PASS] `bun run check`

</details>

---

Ported by: [Repo Port Bot](<bot repo url>)
```

Key design choices:

- **`## Port rationale`** starts with the decision rationale as a blockquote — the "why" is still first, but it remains visually distinguished from the rest of the narrative
- **The provenance sentence follows the rationale** — source PR/repo traceability plus a parenthetical `@`-mention of the original PR author (so they receive a GitHub notification about the port without implying they authored the port itself) plus execution attribution (model, files changed, attempts, tool calls, duration) reads as one natural sentence
- **`## What was ported`** is the main content — a structured summary with prose overview and per-file bullet descriptions gets top billing without extra metadata interrupting the section
- **`Work Log` as a collapsed details block** — assistant narration in _italics_, tool actions grouped in fenced code blocks, rendered in full (no truncation). The final assistant note from the last attempt is stripped since it duplicates the "What was ported" summary above
- **Validation and diagnostics in a collapsible `<details>` block** — present but not taking up space on happy paths. For stalled/draft ports, the block uses `<details open>` so failure info is immediately visible
- **Cost/token telemetry lives in a collapsed details block in the target PR** — reviewer-facing PRs still stay focused on rationale, changes, and validation by default, while maintainers can expand a compact `Cost & Tokens` block when they want execution telemetry
- **`Ported by: Repo Port Bot`** footer linking to the bot repository, after a horizontal rule for clean separation (the git commit trailer `Ported-By: repo-port-bot` remains the machine-parseable loop prevention signal)

Detailed event logs and per-stage token/cost totals are surfaced in the **job summary** as nested collapsible "Log" sections inside the Decision and Execution blocks — see [observability.md](observability.md) for the layout. The target PR carries the same telemetry in a compact collapsed block so reviewers can inspect spend/usage without leaving GitHub.

Telemetry rendering is controlled by a workflow-level action input:

- **`include-cost-telemetry`** (default `true`) — when `true`, render the `Cost & token usage` blocks in the target PR body, source PR comment, and Actions job summary
- When `false`, omit all user-facing cost/token sections while still allowing raw trace data to exist internally for debugging or future artifacts

For **multi-attempt runs** (stalled ports), the `Work Log` section uses per-attempt headings (`### Attempt 1`, `### Attempt 2`) so retries are easy to follow.

**How summaries/logs are captured:** The provider requests structured output (`PortSummary`) from the model — a prose overview plus per-file descriptions — which the PR renderer uses for `## What was ported`. When structured output is unavailable, the renderer falls back to the last assistant message text (`trace.notes`). In parallel, the provider records ordered attempt events (assistant text + tool start/end lifecycle) so the PR renderer can build the collapsed, humanized `Work Log` narrative.

**PR state:**

| Outcome                                        | PR state         | Labels                      |
| ---------------------------------------------- | ---------------- | --------------------------- |
| Validations pass (agent or deterministic-only) | Ready for review | `auto-port`                 |
| Validations fail after retries                 | Draft            | `auto-port`, `port-stalled` |
| Deterministic changes + residual `NEEDS_HUMAN` | Ready for review | `auto-port`                 |

See [`state-machine.md`](state-machine.md) for the full artifact-selection logic.

Source: GitHub REST API (`POST /repos/{owner}/{repo}/pulls`).

### Issue creation (NEEDS_HUMAN, no deterministic changes)

When the residual classification returns `NEEDS_HUMAN` and no deterministic operations produced target-side changes, the engine opens or updates an issue in the target repo instead of attempting a port. When deterministic changes exist, the engine opens a PR instead (see PR creation above and [`state-machine.md`](state-machine.md)).

- Tagged `needs-human`
- Compact title: `Needs review: <source PR title (truncated to 60 chars)>`
- Body is a short narrative with the source PR link, reason, file count, and machine-readable source identity lines (`Source-PR`, `Source-Commit`) so reruns can reuse the same open issue

**Example body:**

```md
[Add formatting/date helpers](https://github.com/handlebauer/port-bot-test-source/pull/1) (originally authored by @author) was merged in `port-bot-test-source` but could not be automatically ported.

**Why:** Classifier could not determine a safe automatic port target.

**Changed files:** 2
```

### Labels

Labels are created on first use via the GitHub API (no manual pre-creation needed):

| Label          | Purpose                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `auto-port`    | Marks bot-created PRs; used for loop prevention                                                             |
| `port-stalled` | Marks draft PRs where validation failed after retries; removed on successful re-runs when the PR is updated |
| `needs-human`  | Marks issues requiring manual decision                                                                      |
| `no-port`      | User-applied to source PRs to skip porting                                                                  |

### Source PR notification

The engine posts a best-effort comment on the source PR for every outcome (including skips) to close the traceability loop. Stalled, needs-human, skipped, and failed outcomes use GitHub admonitions for visual clarity. Successful `pr_opened` comments are plain markdown with a collapsible reason section.

When available, the source PR comment also includes compact spend/usage telemetry. For successful or stalled runs, the comment should show:

- Decision cost and token totals from the classifier call
- Execution cost and token totals aggregated across all execution attempts
- Overall run cost and token totals as the sum of decision + execution

For decision-only outcomes such as `skipped_not_required` or `needs_human`, only the decision totals are shown.

This notification is non-blocking: comment failures never change the terminal run outcome.

On reruns, the bot updates the same managed source PR comment for that target repo in place. A `Supersedes [prior attempt]` note is now a fallback case that only appears when the bot has to create a new comment instead of updating the existing managed one.

**Admonition mapping:**

| Outcome                | Admonition   | Tone                       |
| ---------------------- | ------------ | -------------------------- |
| `pr_opened`            | none         | Success — ready for review |
| `skipped_not_required` | `[!NOTE]`    | Informational — no action  |
| `draft_pr_opened`      | `[!WARNING]` | Needs attention — stalled  |
| `needs_human`          | `[!WARNING]` | Needs attention — manual   |
| `failed`               | `[!CAUTION]` | Engine error               |

The decision reason is rendered in a collapsible `<details>` block so comments stay compact while the full rationale remains accessible. For admonition-backed outcomes, the details block is nested inside the admonition body.

**Example comment** (`pr_opened`):

```md
Ported to https://github.com/acme/target-repo/pull/901 (2 files, validation passed).

<details><summary>Why was this ported?</summary>

Source changes affect shared API surface that exists in both repos.

</details>

<details><summary>Cost & Tokens</summary>

- Decision: $0.12, 2.5k tokens
- Execution: $1.34, 18.9k tokens across 2 attempts
- Total: $1.46, 21.4k tokens

</details>
```

## Loop prevention

The engine prevents TS→Py→TS echo loops by checking the `auto-port` label during the decision heuristics phase. Bot-created port PRs are always labeled `auto-port`, so when a port PR is merged and triggers the reverse workflow, the heuristic skips it.

Two additional signals are written but not yet checked by the engine:

- **Commit footer**: `Ported-By: repo-port-bot` is added to every port commit (useful for manual inspection or future workflow-level checks).
- **Branch name**: port branches follow the `port/…` naming convention (useful for branch protection rules or future checks).

These are available for workflows to check before invoking the engine, but the engine itself relies solely on the `auto-port` label.

## Authentication

### v1: secrets-based

The root action supports two token modes:

1. **Single token mode**
    - Input: `github-token`
    - One GitHub API token is used for both source reads and target writes.

2. **Split token mode**
    - Inputs: `source-github-token`, `target-github-token`
    - Source token is used for source-repo API reads.
    - Target token is used for git push + target-repo PR/issue/label writes and source PR notification comments.

`llm-api-key` is always required and is not used for GitHub API auth.

Additional presentation input:

- `include-cost-telemetry` — optional boolean input that defaults to `true`. This controls whether user-facing telemetry blocks are rendered in the target PR, source PR comment, and Actions job summary.

These inputs accept any GitHub token that has the required permissions. Today most users provide PATs, but installation tokens from a GitHub App already work with the current action surface. That means an org-owned, consumer-managed GitHub App can replace PATs without engine or action code changes: the workflow generates installation tokens with `actions/create-github-app-token` and passes them through the existing token inputs.

### Future: GitHub App

- **Supported today**: org-owned, consumer-managed app. The company owns the app and generates installation tokens in the workflow, then passes them through `github-token` or the split token inputs. No code changes required.
- **Future path**: first-party Repo Port Bot app. The consumer installs the app and the action authenticates internally with no token inputs. This requires a hosted token exchange service and additional action logic.
- Permissions needed:
    - Source repo: `contents:read`, `pull_requests:read`
    - Target repo: `contents:write`, `pull_requests:write`, `issues:write` (plus the ability to comment on the source PR when split-token mode is used)

## GitHub Action surface

### Workflow (installed in SDK repos)

```yaml
# .github/workflows/port-bot.yml
name: Port Bot
on:
    push:
        branches: [main]

jobs:
    port:
        runs-on: ubuntu-latest
        permissions:
            contents: read
            pull-requests: read
        steps:
            - uses: superbuilders/repo-port-bot@v1
              with:
                  llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
                  github-token: ${{ secrets.PORT_BOT_GITHUB_TOKEN }}
                  target-repo: acme/target-repo
```

### Action definition (in this repo)

Lives at repo root `action.yml` as a composite action.

Responsible for:

- Parsing action inputs and token mode
- Cloning source repo at merge SHA (read-only reference + diff computation)
- Cloning target repo at default branch (agent working directory)
- Installing Bun and production dependencies at runtime in `${GITHUB_ACTION_PATH}`
- Running the engine entrypoint from `packages/action/src/index.ts` via `bun run`
- Publishing action outputs for downstream workflow steps

### Release workflow

`.github/workflows/release.yml` triggers on push to `main` or manual dispatch:

1. Install, check, test
2. Force-update `v1` tag to point at current `main`

Users reference `@v1` which always points to the latest release commit on `main`.

### workflow_dispatch for port re-runs (v2)

The action supports manual replay through `workflow_dispatch` using the existing event SHA or an explicit `commit-sha` override. The next likely expansion is supporting a source PR number directly rather than only discovering the source PR from a commit SHA.

## Plain pushes (no PR)

Currently the engine skips (`NO_AGENT_PORT_NEEDED`) when a push event cannot be associated with a merged pull request. Without PR metadata the pipeline lacks a changed-file list, labels, and title/body context needed by heuristics, agent prompts, and delivery rendering.

Future work to support plain pushes:

- Populate `sourceChange.files` from the local `git diff HEAD~1` output instead of the GitHub list-files API.
- Allow heuristics and rendering to operate on commit metadata alone.
- Handle multi-commit pushes where `HEAD~1` only captures the last commit.

## Open questions

- Do we need rate-limit handling for GitHub API calls?
- Should PR body rendering be configurable per plugin or is a single format enough?
