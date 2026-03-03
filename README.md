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

Add a workflow to both repos:

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

### 2. Configure secrets

| Secret                  | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `PORT_BOT_LLM_API_KEY`  | LLM provider API key (Anthropic, OpenAI, etc.) |
| `PORT_BOT_GITHUB_TOKEN` | PAT with `repo` scope on the target repo       |

The source repo's built-in `GITHUB_TOKEN` handles reading PR metadata and diffs.

### 3. Configure your repo pair

There are two ways to teach the bot about your repos. Pick whichever fits your situation.

**Option A: Built-in plugin**: best when you're contributing to repo-port-bot itself or want tight control. You add a plugin directly under `src/plugins/` in this repo:

```
src/plugins/my-project/
  config.ts       # repo pairing, ignore patterns, validation commands
  mapping.json    # module-to-module path correspondences
  prompts.md      # custom agent instructions
```

**Option B: Declarative config in your repos**: best when you want to keep porting config alongside the code it describes. Add a `port-bot.json` to each SDK repo's root:

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

- **Repo pairing**: source ↔ target mapping, ignore patterns, validation commands
- **Mapping rules**: path correspondences, naming conventions (camelCase ↔ snake_case), how errors/auth/pagination translate
- **Agent instructions**: style rules, domain context, edge-case guidance

Option A takes precedence when both exist. You can also combine them — e.g., keep the plugin in this repo for stable config and use `port-bot.json` in each SDK for repo-specific overrides that change more often.

## Port decision logic

The bot skips porting when:

- Only docs changed (README, markdown, `docs/`)
- Only CI/config changed (`.github/`, tooling)
- Only formatting changed
- The PR is labeled `no-port`

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

```
packages/
  engine/         # core automation + agent runner
  plugins/        # repo-specific port logic (one dir per plugin)
  utils/          # shared CLI utilities
scripts/          # workspace tooling
```
