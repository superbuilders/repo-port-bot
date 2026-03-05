# First-Time Setup: Onboarding a Repo Pair

This story covers the one-time experience of installing the port bot on a pair of repositories for the first time.

If implementation details and this story diverge, this story is the product intent to reconcile against.

## Purpose

Define what a smooth onboarding looks like. The maintainer should go from "no bot" to "first successful port" with minimal configuration, and have a clear path to tuning behavior once they see real results.

## Primary actor

- SDK maintainer responsible for a paired repo setup (e.g., TypeScript SDK as source, Python SDK as target).

## Trigger

- The maintainer decides to automate porting between two repositories and is setting up the bot for the first time.

## Preconditions

- Two repositories exist that share overlapping functionality (e.g., SDKs for the same API in different languages).
- The maintainer has admin or write access to both repos.
- The maintainer has an Anthropic API key for the Claude agent.
- The maintainer has a GitHub personal access token (PAT) with access to both repos, or separate tokens for each.

## Narrative

1. **Maintainer creates the workflow file**
    - In the **source** repository, the maintainer adds `.github/workflows/port-bot.yml`:

    ```yaml
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

    - This is the minimal configuration. Only three inputs are required: `llm-api-key`, a GitHub token, and `target-repo`.
    - Everything else has defaults: `target-default-branch` defaults to `main`, `max-attempts` to `3`, `model` to `claude-sonnet-4-6`, `log-level` to `info`.

2. **Maintainer configures secrets**
    - In the source repo's Settings > Secrets and variables > Actions:
        - `PORT_BOT_LLM_API_KEY` — Anthropic API key.
        - `PORT_BOT_GITHUB_TOKEN` — PAT with `contents:write`, `pull-requests:write`, and `issues:write` on the target repo, plus `contents:read` and `pull-requests:read` on the source repo.
    - If the maintainer prefers split tokens (different permissions or different owners for source vs target):
        - `PORT_BOT_SOURCE_GITHUB_TOKEN` — read-only access to source repo.
        - `PORT_BOT_TARGET_GITHUB_TOKEN` — write access to target repo.
        - The workflow uses `source-github-token` and `target-github-token` inputs instead of `github-token`.

3. **Maintainer optionally adds `port-bot.json`**
    - At the root of the **source** repo, the maintainer can create `port-bot.json` to configure behavior beyond action inputs:

    ```json
    {
    	"target": "acme/target-repo",
    	"validation": ["bun run check", "bun run test"],
    	"mapping": {
    		"src/": "packages/core/src/"
    	},
    	"ignore": ["scripts/**", "*.config.*"],
    	"conventions": {
    		"naming": "Target repo uses snake_case for file names and Python conventions."
    	},
    	"prompt": "The target repo is a Python SDK. Use idiomatic Python patterns."
    }
    ```

    - All fields are optional. Action inputs take precedence over `port-bot.json` values.
    - The engine fetches this file from the source repo at the merge commit SHA. If the file doesn't exist, nothing breaks — the engine uses action inputs and defaults.
    - The `skip-port-bot-json: true` action input disables this fetch entirely.

4. **Maintainer verifies the first run**
    - Merge a small, representative PR in the source repo.
    - Check the Actions tab — the "Port Bot" workflow should appear and run.
    - Expected outcomes for a first run:
        - If the source change is docs-only or config-only: `skipped_not_required`. The source PR gets a comment explaining the skip. This confirms the bot is wired up and decision heuristics work.
        - If the source change has portworthy code: a PR should appear in the target repo (or a draft PR if validation fails, or an issue if the change is too complex).
    - The job summary in the Actions run shows the outcome, decision reason, timing, and links.

5. **Maintainer reviews and adjusts**
    - After seeing the first port result, the maintainer can tune:
        - **Validation commands** — add or adjust commands that the agent runs to verify its work (e.g., `bun run check`, `pytest`).
        - **Path mappings** — help the agent understand where source paths correspond to target paths when the directory structures differ.
        - **Naming conventions** — guide the agent on language-specific conventions (e.g., `camelCase` vs `snake_case`).
        - **Custom prompt** — add repo-specific context the agent needs to make good decisions.
        - **Ignore patterns** — exclude paths that should never trigger a port (scripts, CI config, tooling). This is only configurable via `port-bot.json`, not as an action input.
    - Validation commands, path mappings, naming conventions, and prompt can be set in the workflow YAML (action inputs) or in `port-bot.json`. Action inputs are better for values that rarely change; `port-bot.json` is better for values that evolve with the codebase and should be versioned alongside the source code.

## User-visible definition of success

The maintainer experiences onboarding as "three required inputs and the bot works":

- A minimal workflow file with `llm-api-key`, `github-token`, and `target-repo` is enough to get a first run.
- The first run produces an observable result — a PR, draft PR, issue, or skip comment — that confirms the bot is working.
- The maintainer can iterate on config without re-deploying anything; changes to `port-bot.json` take effect on the next merge.
- There are no manual label creation steps, no target-repo workflow to install, and no database or external service to provision.

## Acceptance criteria

1. **Minimal viable config**
    - The bot runs successfully with only `llm-api-key`, a GitHub token, and `target-repo`. All other inputs have working defaults.

2. **Clear first-run feedback**
    - The job summary in the Actions run shows the run outcome, decision reason, and any produced URLs. The maintainer can tell whether the bot worked without reading raw logs.

3. **Incremental configuration**
    - Every optional input (`validation-commands`, `path-mappings`, `naming-conventions`, `prompt`) and `port-bot.json` field (`ignore`, `conventions`) improves results when provided but is not required for the bot to function.

4. **Config layering**
    - Action inputs take precedence over `port-bot.json`. Both are optional beyond the required three. The merge behavior is predictable: action input wins when both specify the same field.

5. **No target-repo setup**
    - The target repo requires no workflow file, no config file, and no pre-created labels. The bot creates PRs, issues, and labels as needed.

## Common pitfalls

- **Token permissions too narrow**: the PAT needs write access to the target repo for PR creation and git push. A read-only token will fail at the delivery stage. The error appears in the Actions log as a push or API 403.
- **No validation commands configured**: the bot defaults to no validation. The agent will apply changes and the PR will be opened as ready-for-review even if the code doesn't compile. Adding at least one validation command (type check, lint, test) is strongly recommended.
- **No validation commands configured**: the bot defaults to no validation. The PR body explicitly says validation was not run (instead of implying pass/fail from command output), but the PR can still be ready-for-review. Adding at least one validation command (type check, lint, test) is strongly recommended.
- **Wrong `target-repo` format**: must be `owner/name` (e.g., `acme/python-sdk`). A bare repo name without the owner will fail at input parsing.
- **Source repo is private, target is in a different org**: split tokens are needed because a single PAT may not have cross-org access.

## What this story does not cover

- Installing the workflow in the target repo. The target repo does not need a port bot workflow — the bot operates entirely from the source repo's Actions runner.
- GitHub App authentication. v1 uses personal access tokens. A future GitHub App mode will simplify auth but the onboarding steps will change.
- Configuring the `no-port` label convention for the team. This is a team workflow decision, not a setup step.
