# repo-port-bot

Automatically port changes between paired repositories. When a PR merges in one repo, an LLM agent decides whether the change should exist in the other repo, implements it, runs validations, and opens a PR.

## How it works

1. A PR merges in your source repo
2. A GitHub Action triggers the port bot engine
3. The engine fetches the PR context and diff
4. Heuristics + an LLM classifier decide whether to port
5. If yes, an agent applies the equivalent change in the target repo
6. Validations run — if they fail, the agent iterates (up to a configured max)
7. A PR opens in the target repo linking back to the source

If the agent can't confidently port, it opens a draft PR or an issue tagged `needs-human`.

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

### 2. Choose token mode

The action supports both a single-token mode and a split-token mode.

#### Single token (simple)

Use one PAT for source reads + target writes:

```yaml
with:
    llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
    github-token: ${{ secrets.PORT_BOT_GITHUB_TOKEN }}
    target-repo: acme/target-repo
```

#### Split tokens (least privilege)

Use separate PATs for source/target access:

```yaml
with:
    llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
    source-github-token: ${{ secrets.PORT_BOT_SOURCE_GITHUB_TOKEN }}
    target-github-token: ${{ secrets.PORT_BOT_TARGET_GITHUB_TOKEN }}
    target-repo: acme/target-repo
```

### 3. Configure secrets

| Secret                         | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `PORT_BOT_LLM_API_KEY`         | LLM provider API key (Anthropic)                   |
| `PORT_BOT_GITHUB_TOKEN`        | Single-token mode: source reads + target writes    |
| `PORT_BOT_SOURCE_GITHUB_TOKEN` | Split mode: source repo read token                 |
| `PORT_BOT_TARGET_GITHUB_TOKEN` | Split mode: target repo write token (PR/issue/git) |

### 4. Configure your repo pair

There are two ways to configure the bot. Pick whichever fits your situation.

**Option A: Action inputs**: pass config directly in your workflow file. This is the simplest approach — `target-repo` is required, everything else has sensible defaults:

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

**Option B: Declarative config in your repos**: best when you want to keep porting config alongside the code it describes. Add a `port-bot.json` to the source repo's root:

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

The engine reads `port-bot.json` from the source repo at runtime. No code executes from it: it's purely declarative.

Both options configure the same things:

- **Repo pairing**: target repo, ignore patterns, validation commands
- **Mapping rules**: path correspondences, naming conventions (camelCase ↔ snake_case)
- **Agent instructions**: style rules, domain context, edge-case guidance

Action inputs take precedence when both exist. You can combine them — e.g., keep stable config in the workflow and use `port-bot.json` for repo-specific overrides that change more often.

## Port decision logic

The bot skips porting when:

- Only docs changed (README, markdown, `docs/`)
- Only CI/config changed (`.github/`, tooling, root JSON files)
- The PR is labeled `no-port`
- The PR is a bot-generated port (loop prevention via `auto-port` label)

Otherwise, the LLM classifies the change as `PORT_REQUIRED`, `PORT_NOT_REQUIRED`, or `NEEDS_HUMAN`.

## Loop prevention

Port PRs are labeled `auto-port`. The workflow ignores merges from PRs with that label, commits containing `Ported-By: repo-port-bot`, or branches matching `port/…`.

## Development

```bash
bun install
bun run check    # typecheck + lint
bun run test     # unit tests
bun run build    # build all packages
```

## Project structure

Monorepo managed with `bun` workspaces and `turbo`. Packages live under `packages/`, architecture docs under `docs/`.
