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

Auth: `PORT_BOT_GITHUB_TOKEN` (PAT with `repo` scope on the target).

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
| Validations fail after retries | Draft            | `auto-port`, `failed-tests` |

Source: GitHub REST API (`POST /repos/{owner}/{repo}/pulls`).

### Issue creation (NEEDS_HUMAN)

When the decision stage returns `NEEDS_HUMAN`, the engine opens an issue in the target repo instead of attempting a port.

- Tagged `needs-human`
- Links to source PR
- Includes decision rationale and any signals

### Labels

Labels the engine expects to exist (or creates on first use):

| Label          | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `auto-port`    | Marks bot-created PRs; used for loop prevention |
| `failed-tests` | Marks draft PRs where validation failed         |
| `needs-human`  | Marks issues requiring manual decision          |
| `no-port`      | User-applied to source PRs to skip porting      |

## Loop prevention

Three signals prevent TS→Py→TS echo loops. At least two must be checked:

1. **Label**: source PR has `auto-port` label → skip
2. **Commit footer**: merge commit contains `Ported-By: repo-port-bot` → skip
3. **Branch name**: branch matches `port/…` pattern → skip

The workflow should check these before invoking the engine. The engine also checks during the decision heuristics phase as a safety net.

## Authentication

### v1: secrets-based

| Secret                                    | Scope            | Used for                                    |
| ----------------------------------------- | ---------------- | ------------------------------------------- |
| `GITHUB_TOKEN` (automatic)                | Source repo      | Read PR metadata, diff, labels, contents    |
| `PORT_BOT_GITHUB_TOKEN` (user-configured) | Target repo      | Push branch, create PR/issue, manage labels |
| `PORT_BOT_LLM_API_KEY` (user-configured)  | N/A (not GitHub) | LLM provider calls                          |

`GITHUB_TOKEN` is provided automatically by GitHub Actions with read permissions on the source repo. No user configuration needed.

`PORT_BOT_GITHUB_TOKEN` must be a PAT with `repo` scope on the target repo. This is the only token that crosses repo boundaries.

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
        steps:
            - uses: superbuilders/repo-port-bot@v1
              with:
                  llm_api_key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
                  github_token: ${{ secrets.PORT_BOT_GITHUB_TOKEN }}
```

### Action definition (in this repo)

Lives at `.github/actions/port/` (composite action) or as a Docker action.

Responsible for:

- Installing engine dependencies
- Checking out source repo at merge SHA
- Checking out target repo at default branch
- Running the engine entrypoint
- Passing secrets as environment variables

### workflow_dispatch (v2)

Manual re-run support:

```yaml
on:
    workflow_dispatch:
        inputs:
            pr_number:
                description: 'Source PR number to port'
                required: true
```

Not in scope for v1 but the engine should accept a PR number as input rather than only discovering it from the push event.

## Open questions

- Should the engine create labels automatically if they don't exist, or require pre-setup?
- Should the engine comment back on the source PR with a link to the target PR?
- Do we need rate-limit handling for GitHub API calls?
- Should PR body rendering be configurable per plugin or is a single format enough?

## Decisions log

### Decision template

- **Date**:
- **Question**:
- **Decision**:
- **Rationale**:
