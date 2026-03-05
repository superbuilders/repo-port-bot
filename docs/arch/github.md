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
- Merge commit SHA

Source: GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{pull_number}`)

### Diff and changed files

- File paths, statuses (added/modified/deleted/renamed), additions/deletions counts
- Full diff computed locally via `git diff HEAD~1` in the source clone, saved to `port-diff.patch`

The per-file `patch` field from the GitHub list-files API is still used by decision-stage
heuristics (docs-only, config-only) but the agent prompt uses the locally-computed diff
file instead — no truncation, no missing patches.

Source: GitHub REST API for file list + stats; `git diff` from source clone for diff content.

### port-bot.json (optional)

- Fetched from source repo root at the merged commit SHA via GitHub Contents API
- 404 is not an error — the file is optional; other fetch failures warn but don't fail the run
- Parsed via `port-bot-json.decoder.ts` (runtime validation with `decoders.cc`)
- Merged with built-in config (action inputs take precedence, `port-bot.json` fills gaps)
- `runPort()` auto-fetches when the caller doesn't provide `portBotJson` externally
- Action input `skip-port-bot-json: true` disables the fetch for faster runs

Source: GitHub Contents API (`GET /repos/{owner}/{repo}/contents/port-bot.json?ref={sha}`).

## Writes (target repo)

These happen after the agent has produced edits and validation has passed (or retries are exhausted).

### Branch creation and push

- Branch naming: `port/<sourceRepo>/<sourcePrNumber>-<shortSha>`
- Force-push the port branch to the target repo remote. The branch is bot-owned (deterministic naming), so force-push is safe and makes re-runs idempotent — fresh agent output replaces any previous attempt on the same branch.

Auth: `github-token` (single-token mode) or `target-github-token` (split-token mode).

### Pull request creation (upsert)

On first run, a new PR is created. On re-runs where the port branch already has an open PR (from a previous attempt), the engine finds the existing PR and updates its title and body instead of failing. This means re-triggering a workflow produces an updated PR rather than an error.

**Title format:**

```
Port: <source PR title> (#<source PR number>)
```

**Body layout:**

```md
## Cross-repo port

Ported from [<source PR title>](url) in [`<owner>/<repo>`](<repo url>).

> <decision reason as blockquote>
>
> - claude-sonnet-4-6

2 files changed · 1 attempt · 5 tool calls

### What was ported

<agent summary — per-file descriptions of changes>

<details><summary>Validation & diagnostics</summary>

- [PASS] `bun run check`

</details>

---

[Ported-By: repo-port-bot](<bot repo url>)
```

Key design choices:

- **`## Cross-repo port`** heading with source narrative immediately below — orients the reader in one glance
- **Decision reason as blockquote** — reads as context, not a separate section
- **`### What was ported`** is the main content — the agent's per-file summary gets top billing
- **Validation and diagnostics in a collapsible `<details>` block** — present but not taking up space on happy paths. For stalled/draft ports, the block uses `<details open>` so failure info is immediately visible
- **At-a-glance stats line** (`2 files changed · 1 attempt · 5 tool calls`) between the source narrative and reason blockquote — sets reviewer expectations for diff size before reading details
- **Decision blockquote** includes the agent model name (e.g. `claude-sonnet-4-6`) as a trailing bullet, keeping "who and why" context together
- **`Ported-By: repo-port-bot`** footer linking to the bot repository, after a horizontal rule for clean separation (also serves as loop prevention signal)

For **multi-attempt runs** (stalled ports), the "What was ported" section uses per-attempt headings (`### Attempt 1`, `### Attempt 2`) with touched-in-attempt lines. Single-attempt runs omit this nesting.

**How agent notes are captured:** The provider keeps only the text from the _last_ assistant message before the SDK returns a result. In practice the model's final message is a natural wrap-up summary (per-file descriptions, what was added/changed), but this is emergent behavior — there is no explicit prompt instruction requesting a structured summary. If consistency becomes an issue, a follow-up could add a closing instruction to the system prompt or post-process the notes into a fixed format.

**PR state:**

| Outcome                        | PR state         | Labels                      |
| ------------------------------ | ---------------- | --------------------------- |
| Validations pass               | Ready for review | `auto-port`                 |
| Validations fail after retries | Draft            | `auto-port`, `port-stalled` |

Source: GitHub REST API (`POST /repos/{owner}/{repo}/pulls`).

### Issue creation (NEEDS_HUMAN)

When the decision stage returns `NEEDS_HUMAN`, the engine opens an issue in the target repo instead of attempting a port.

- Tagged `needs-human`
- Compact title: `Needs review: <source PR title (truncated to 60 chars)>`
- Body is a short narrative with the source PR link, reason, and file count

**Example body:**

```md
[Add formatting/date helpers](https://github.com/handlebauer/port-bot-test-source/pull/1) was merged in `port-bot-test-source` but could not be automatically ported.

**Why:** Classifier could not determine a safe automatic port target.

**Changed files:** 2
```

### Labels

Labels the engine expects to exist (or creates on first use):

| Label          | Purpose                                               |
| -------------- | ----------------------------------------------------- |
| `auto-port`    | Marks bot-created PRs; used for loop prevention       |
| `port-stalled` | Marks draft PRs where validation failed after retries |
| `needs-human`  | Marks issues requiring manual decision                |
| `no-port`      | User-applied to source PRs to skip porting            |

### Source PR notification

The engine posts a best-effort comment on the source PR for every outcome (including skips) to close the traceability loop. Each comment includes the `decision.reason` so the maintainer understands what happened without leaving the source repo.

The reason string comes from whichever decision path fired: a hardcoded heuristic message for fast-path skips, or the LLM classifier's free-text explanation when no heuristic matched.

This notification is non-blocking: comment failures never change the terminal run outcome.

On reruns, non-failure comments can include a supersession line that links a prior failed comment (and run ID), for example: `Supersedes prior failed attempt: <comment-url> (run <id>).`

**Example comments:**

`skipped_not_required` (heuristic reason):

```md
Port bot skipped this for `acme/target-repo`.

**Why:** Skipping because all changed files are documentation-only.
```

`pr_opened` (classifier reason):

```md
Ported to https://github.com/acme/target-repo/pull/901 (2 files, validation passed). Ready for review.

**Why:** Source changes affect shared API surface that exists in both repos.
```

`draft_pr_opened` (classifier reason):

```md
Port attempted (2 files) but validation failed after retries. Opened a draft PR: https://github.com/acme/target-repo/pull/333.

**Why:** Source changes affect shared API surface that exists in both repos.
```

`needs_human` (classifier reason):

```md
Could not automatically port to `acme/target-repo`. Opened an issue: https://github.com/acme/target-repo/issues/55 for manual review.

**Why:** Classifier could not determine a safe automatic port target.
```

`failed` (engine fallback reason):

```md
Port to `acme/target-repo` failed due to an engine error.

**Why:** Engine failure before decision completed: GitHub API returned 403

Run ID: `run-abc123`
```

## Loop prevention

Three signals prevent TS→Py→TS echo loops. At least two must be checked:

1. **Label**: source PR has `auto-port` label → skip
2. **Commit footer**: merge commit contains `Ported-By: repo-port-bot` → skip
3. **Branch name**: branch matches `port/…` pattern → skip

The workflow should check these before invoking the engine. The engine also checks during the decision heuristics phase as a safety net.

## Authentication

### v1: secrets-based

The root action supports two token modes:

1. **Single token mode**
    - Input: `github-token`
    - One PAT is used for both source reads and target writes.

2. **Split token mode**
    - Inputs: `source-github-token`, `target-github-token`
    - Source token is used for source-repo API reads.
    - Target token is used for git push + target-repo PR/issue/label writes.

`llm-api-key` is always required and is not used for GitHub API auth.

### Future: GitHub App

- Replaces both tokens with a single GitHub App installation
- App is installed on both repos with fine-grained permissions
- No personal tokens; org-level management
- Permissions needed:
    - Source repo: `contents:read`, `pull_requests:read`
    - Target repo: `contents:write`, `pull_requests:write`, `issues:write`

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

Not in scope for v1 but the engine should accept a PR number as input rather than only discovering it from the push event.

## Plain pushes (no PR)

Currently the engine skips (`PORT_NOT_REQUIRED`) when a push event cannot be associated with a merged pull request. Without PR metadata the pipeline lacks a changed-file list, labels, and title/body context needed by heuristics, agent prompts, and delivery rendering.

Future work to support plain pushes:

- Populate `sourceChange.files` from the local `git diff HEAD~1` output instead of the GitHub list-files API.
- Allow heuristics and rendering to operate on commit metadata alone.
- Handle multi-commit pushes where `HEAD~1` only captures the last commit.

## Open questions

- Should the engine create labels automatically if they don't exist, or require pre-setup?
- Do we need rate-limit handling for GitHub API calls?
- Should PR body rendering be configurable per plugin or is a single format enough?
