# GitHub & Git Operations

All GitHub API interactions and git operations the engine performs. Covers reading source context, writing to the target repo, and the workflow/action surface area.

## Reads (source repo)

These happen early in the pipeline to build `PortContext`.

### PR metadata

- PR number, title, body, URL
- Labels (needed for `no-port` / `auto-port` detection)
- Merge commit SHA

Source: GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{pull_number}`)

### Diff and changed files

- File paths, statuses (added/modified/deleted/renamed), additions/deletions counts
- Full diff content for prompt construction

Source: GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{pull_number}/files`) or git diff against the merge commit.

### port-bot.json (optional)

- Fetched from source repo root at the merged commit SHA
- Parsed and merged with built-in plugin config

Source: GitHub Contents API or read from the checked-out source repo on disk.

## Writes (target repo)

These happen after the agent has produced edits and validation has passed (or retries are exhausted).

### Branch creation and push

- Branch naming: `port/<sourceRepo>/<sourcePrNumber>-<shortSha>`
- Push the port branch to the target repo remote

Auth: `github-token` (single-token mode) or `target-github-token` (split-token mode).

### Pull request creation

**Title format:**

```
Port: <source PR title> (#<source PR number>)
```

**Body includes:**

- Link to source PR
- Summary of what was ported
- Files touched
- Validation commands and results
- Agent notes / uncertainties (if any)
- `Ported-By: repo-port-bot` footer (loop prevention signal)

**PR state:**

| Outcome                        | PR state         | Labels                      |
| ------------------------------ | ---------------- | --------------------------- |
| Validations pass               | Ready for review | `auto-port`                 |
| Validations fail after retries | Draft            | `auto-port`, `port-stalled` |

Source: GitHub REST API (`POST /repos/{owner}/{repo}/pulls`).

### Issue creation (NEEDS_HUMAN)

When the decision stage returns `NEEDS_HUMAN`, the engine opens an issue in the target repo instead of attempting a port.

- Tagged `needs-human`
- Links to source PR
- Includes decision rationale and any signals

### Labels

Labels the engine expects to exist (or creates on first use):

| Label          | Purpose                                               |
| -------------- | ----------------------------------------------------- |
| `auto-port`    | Marks bot-created PRs; used for loop prevention       |
| `port-stalled` | Marks draft PRs where validation failed after retries |
| `needs-human`  | Marks issues requiring manual decision                |
| `no-port`      | User-applied to source PRs to skip porting            |

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

Lives at repo root `action.yml` as a JavaScript action.

Responsible for:

- Parsing action inputs and token mode
- Cloning target repo using PAT-authenticated remote URL
- Running the engine entrypoint from `packages/action/dist/index.js`
- Publishing action outputs for downstream workflow steps

### Release workflow

`.github/workflows/release.yml` triggers on push to `main` or manual dispatch:

1. Install, check, test
2. Build action bundle via esbuild
3. Force-add `packages/action/dist/index.js` and commit (if changed)
4. Force-update `v1` tag

Users reference `@v1` which always points to the latest release build on `main`.

### workflow_dispatch for port re-runs (v2)

Not in scope for v1 but the engine should accept a PR number as input rather than only discovering it from the push event.

## Open questions

- Should the engine create labels automatically if they don't exist, or require pre-setup?
- Should the engine comment back on the source PR with a link to the target PR?
- Do we need rate-limit handling for GitHub API calls?
- Should PR body rendering be configurable per plugin or is a single format enough?
