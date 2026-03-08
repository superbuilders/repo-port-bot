# repo-port-bot

Automatically port changes between paired repositories. When a PR merges in one repo, an LLM agent decides whether the change should exist in the other repo, implements it, runs validations, and opens a PR.

## How it works

1. A PR merges in your source repo
2. A GitHub Action triggers the port bot engine
3. The engine clones the source repo at the merge commit and computes a full diff
4. Heuristics run first (docs-only, config-only, label checks). If inconclusive, an LLM classifier inspects both repos and decides: `PORT_REQUIRED`, `PORT_NOT_REQUIRED`, or `NEEDS_HUMAN`
5. If required, an agent reads the source diff, applies equivalent changes in the target repo, and produces a structured summary
6. Validation commands run. If they fail, the agent iterates with feedback (up to a configured max)
7. A PR opens in the target repo linking back to the source, with a reviewer-facing summary and collapsible work log

Possible outcomes:

- **PR opened**: validations passed; PR is ready for review (labeled `auto-port`)
- **Draft PR opened**: validations failed after retries; draft PR opened for manual intervention (labeled `auto-port`, `port-stalled`)
- **Issue opened**: the classifier determined the change needs human judgment (labeled `needs-human`)
- **Skipped**: heuristics or classifier determined no port is needed; a comment is posted on the source PR explaining why

A notification comment is posted on the source PR for every outcome.

## Setup

### 1. Install the GitHub Action

Add a workflow to your source repo:

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

Only three inputs are required: `llm-api-key`, a GitHub API token, and `target-repo`. Everything else has defaults.

### 2. Choose auth mode

The token inputs accept any GitHub API token — PATs, fine-grained PATs, or installation tokens from a GitHub App.

#### Single token (simple)

One token for source reads + target writes:

```yaml
with:
    llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
    github-token: ${{ secrets.PORT_BOT_GITHUB_TOKEN }}
    target-repo: acme/target-repo
```

#### Split tokens (least privilege)

Separate tokens for source/target access:

```yaml
with:
    llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
    source-github-token: ${{ secrets.PORT_BOT_SOURCE_GITHUB_TOKEN }}
    target-github-token: ${{ secrets.PORT_BOT_TARGET_GITHUB_TOKEN }}
    target-repo: acme/target-repo
```

#### Org-owned GitHub App (recommended)

Avoids tying auth to a personal account. Create a GitHub App under the org, store `APP_ID` and `APP_PRIVATE_KEY` as org-level Actions variables/secrets, and generate installation tokens in the workflow:

```yaml
steps:
    - name: Generate GitHub App token
      id: app-token
      uses: actions/create-github-app-token@v1
      with:
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          repositories: source-repo,target-repo

    - uses: superbuilders/repo-port-bot@v1
      with:
          llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
          github-token: ${{ steps.app-token.outputs.token }}
          target-repo: acme/target-repo
```

For cross-org setups, generate separate source and target installation tokens and pass them to `source-github-token` and `target-github-token`.

### 3. Configure secrets

**PAT mode:**

| Secret                         | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `PORT_BOT_LLM_API_KEY`         | Anthropic API key                                  |
| `PORT_BOT_GITHUB_TOKEN`        | Single-token mode: source reads + target writes    |
| `PORT_BOT_SOURCE_GITHUB_TOKEN` | Split mode: source repo read token                 |
| `PORT_BOT_TARGET_GITHUB_TOKEN` | Split mode: target repo write token (PR/issue/git) |

**GitHub App mode:**

| Secret / variable      | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `PORT_BOT_LLM_API_KEY` | Anthropic API key                       |
| `APP_ID`               | GitHub App ID (Actions variable)        |
| `APP_PRIVATE_KEY`      | GitHub App private key (Actions secret) |

**Required token permissions:**

- Source repo: `contents:read`, `pull_requests:read`, `pull_requests:write` (for notification comments)
- Target repo: `contents:write`, `pull_requests:write`, `issues:write`

### 4. Configure your repo pair

There are two ways to configure the bot. Pick whichever fits your situation.

**Option A: Action inputs** — pass config directly in your workflow file. `target-repo` is required, everything else has sensible defaults:

```yaml
with:
    target-repo: acme/target-repo
    validation-commands: |
        bun run check
        bun run test
    path-mappings: '{"src/": "packages/client/src/"}'
    naming-conventions: 'camelCase -> snake_case'
    prompt: 'Always preserve backward compat...'
```

**Option B: `port-bot.json`** — keep porting config alongside the code it describes. Add to the source repo root:

```json
{
	"target": "org/other-repo",
	"ignore": ["docs/**", ".github/**"],
	"validation": ["bun run test", "bun run check"],
	"mapping": {
		"src/client/": "packages/client/src/"
	},
	"conventions": {
		"naming": "camelCase -> snake_case"
	},
	"prompt": "Timeback SDK: always preserve backward compat..."
}
```

The engine reads `port-bot.json` from the source repo at the merge commit. No code executes from it: it's purely declarative. Set `skip-port-bot-json: true` to disable this fetch.

Action inputs take precedence when both exist. You can combine them — e.g., keep stable config in the workflow and use `port-bot.json` for repo-specific overrides that change more often.

Note: `ignore` patterns are only configurable via `port-bot.json`, not as an action input.

## Action inputs reference

| Input                   | Required | Default             | Description                                                 |
| ----------------------- | -------- | ------------------- | ----------------------------------------------------------- |
| `llm-api-key`           | yes      | —                   | Anthropic API key                                           |
| `target-repo`           | yes      | —                   | Target repository (`owner/name`)                            |
| `github-token`          | no       | —                   | Fallback GitHub API token for source reads + target writes  |
| `source-github-token`   | no       | —                   | GitHub API token for source repository reads                |
| `target-github-token`   | no       | —                   | GitHub API token for target repository writes               |
| `target-default-branch` | no       | `main`              | Default branch for target repo checkout and PR base         |
| `validation-commands`   | no       | —                   | Newline-separated validation commands to run in target repo |
| `path-mappings`         | no       | `{}`                | JSON object mapping source paths to target paths            |
| `naming-conventions`    | no       | —                   | Naming convention guidance for the agent                    |
| `prompt`                | no       | —                   | Additional custom prompt instructions                       |
| `skip-port-bot-json`    | no       | `false`             | Skip fetching `port-bot.json` from source repo              |
| `model`                 | no       | `claude-sonnet-4-6` | Claude model to use                                         |
| `max-attempts`          | no       | `3`                 | Maximum execution attempts before stalling                  |
| `max-turns`             | no       | `50`                | Maximum Claude SDK turns per attempt                        |
| `max-budget-usd`        | no       | —                   | Optional budget cap (USD) for a single attempt              |
| `log-level`             | no       | `info`              | Minimum log level (`error`, `warn`, `info`, `debug`)        |

## Action outputs

| Output      | Description                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `run-id`    | Unique identifier for this port run                                                               |
| `outcome`   | Terminal outcome: `skipped_not_required`, `needs_human`, `pr_opened`, `draft_pr_opened`, `failed` |
| `pr-url`    | URL of created target pull request (when applicable)                                              |
| `issue-url` | URL of created follow-up issue (when applicable)                                                  |
| `summary`   | Human-readable run summary                                                                        |

## Port decision logic

The engine runs heuristics first, then falls through to the LLM classifier if no heuristic matches.

**Heuristic skips** (fast, no LLM call):

- No associated PR (plain push to default branch)
- PR labeled `auto-port` (loop prevention)
- PR labeled `no-port`
- Only docs changed (`README.md`, `*.md`, `docs/**`, `LICENSE`, `CHANGELOG*`)
- Only CI/config changed (`.github/**`, `*.config.*`, `Dockerfile`, `Makefile`, root `*.json`, etc.)
- All changed files match `ignorePatterns` from config

**LLM classification** (when heuristics are inconclusive):

The classifier inspects both repos with read-only tools and returns one of three outcomes:

- `PORT_REQUIRED` — proceed to execution
- `PORT_NOT_REQUIRED` — skip silently
- `NEEDS_HUMAN` — open a follow-up issue for manual review

## Labels

| Label          | Purpose                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `auto-port`    | Marks bot-created PRs; used for loop prevention                                      |
| `port-stalled` | Marks draft PRs where validation failed after retries; removed on successful re-runs |
| `needs-human`  | Marks issues requiring manual decision                                               |
| `no-port`      | User-applied to source PRs to skip porting                                           |

Labels are created on first use via the GitHub API — no manual pre-creation needed.

## Loop prevention

Port PRs are labeled `auto-port`. The engine checks for that label during decision heuristics to prevent echo loops. Commit trailers (`Ported-By: repo-port-bot`) and `port/...` branch names are written for traceability and possible future workflow-level checks, but the engine currently relies on the label.

## Observability

Each run produces:

- **Source PR comment**: notification comment on the source PR for every outcome (skip, port, needs-human, failure) with a collapsible reason section
- **Job summary**: rich markdown on the Actions Summary tab with timing breakdown, collapsible Decision and Execution sections with nested event logs
- **Action outputs**: `run-id`, `outcome`, `pr-url`, `issue-url`, `summary` — available to downstream workflow steps
- **Artifacts**: full tool-call logs and run result JSON uploaded as a GitHub Actions artifact (14-day retention)
- **Structured logs**: `[port-bot]` prefixed lines at configurable log levels (`log-level` input)

## Development

```bash
bun install
bun run check    # typecheck + lint + unused code + copy/paste
bun run test     # unit tests (via Turborepo)
bun run build    # build all packages
```

## Project structure

Monorepo managed with `bun` workspaces and `turbo`.

```
packages/
  action/        GitHub Action entrypoint and composite action wiring
  agent-claude/  Claude Agent SDK provider implementation
  engine/        Core pipeline: decision, execution, delivery, rendering
  logger/        Structured logging utilities
  prompts/       Provider-agnostic prompt templates and builders
  utils/         Shared utilities
docs/
  arch/          Architecture docs (agent loop, GitHub ops, observability, prompting, classification)
  user-stories/  Product-level user stories
  future/        Proposed future capabilities
```
