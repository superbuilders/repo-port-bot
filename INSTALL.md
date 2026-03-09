# Installation Guide

Step-by-step instructions for installing repo-port-bot on your repositories.

## Table of contents

- [Prerequisites](#prerequisites)
- [Step 1: Choose an auth method](#step-1-choose-an-auth-method)
    - [Option A: Single PAT](#option-a-single-pat)
    - [Option B: Split PATs](#option-b-split-pats)
    - [Option C: Org-owned GitHub App (recommended)](#option-c-org-owned-github-app-recommended)
- [Step 2: Add secrets](#step-2-add-secrets)
- [Step 3: Create the workflow file](#step-3-create-the-workflow-file)
- [Step 4: Configure behavior](#step-4-configure-behavior)
    - [Action inputs](#action-inputs)
    - [port-bot.json](#port-botjson)
- [Step 5: Verify the first run](#step-5-verify-the-first-run)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Two repositories that share overlapping functionality (e.g., SDKs for the same API in different languages).
- Admin or write access to both repos.
- An [Anthropic API key](https://console.anthropic.com/) for the Claude agent.

The bot runs entirely from the **source** repository's GitHub Actions runner. The target repository does not need a workflow file, config file, or pre-created labels.

## Step 1: Choose an auth method

The bot needs a GitHub API token with access to both the source and target repos. Pick the option that best fits your situation.

### Option A: Single PAT

Best for: personal projects, small teams, or quick setup.

Create a GitHub personal access token (classic or fine-grained) with these permissions:

| Repository  | Permissions                                                  |
| ----------- | ------------------------------------------------------------ |
| Source repo | `contents:read`, `pull_requests:read`, `pull_requests:write` |
| Target repo | `contents:write`, `pull_requests:write`, `issues:write`      |

Source repo needs `pull_requests:write` because the bot posts notification comments on source PRs.

Store it as a repository secret named `PORT_BOT_GITHUB_TOKEN`.

### Option B: Split PATs

Best for: least-privilege setups, or when source and target repos are in different orgs where a single token can't reach both.

Create two tokens:

| Token        | Repository  | Permissions                                                                                          |
| ------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| Source token | Source repo | `contents:read`, `pull_requests:read`                                                                |
| Target token | Target repo | `contents:write`, `pull_requests:write`, `issues:write`, plus permission to comment on the source PR |

Store them as repository secrets:

- `PORT_BOT_SOURCE_GITHUB_TOKEN`
- `PORT_BOT_TARGET_GITHUB_TOKEN`

### Option C: Org-owned GitHub App (recommended)

Best for: teams and orgs that want auth decoupled from any individual's personal account.

#### 1. Create the GitHub App

Go to your org's settings: **Settings > Developer settings > GitHub Apps > New GitHub App**.

Fill out the creation form:

| Field                                | Value                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| **GitHub App name**                  | Something recognizable (e.g., `Port Bot - YourOrg`)                                    |
| **Homepage URL**                     | `https://github.com/superbuilders/repo-port-bot` (or your own URL)                     |
| **Callback URL**                     | Leave blank                                                                            |
| **Webhook**                          | **Uncheck "Active"** — the app is only used for token generation, not receiving events |
| **Where can this app be installed?** | "Only on this account" (unless you need cross-org installation)                        |

#### 2. Set repository permissions

On the same creation form, scroll to **Permissions & events > Repository permissions**:

| Permission    | Access       |
| ------------- | ------------ |
| Contents      | Read & Write |
| Pull requests | Read & Write |
| Issues        | Read & Write |

Leave all other permissions at "No access." No account permissions or event subscriptions are needed.

Click **Create GitHub App**.

#### 3. Generate a private key

After creating the app, you'll land on the app settings page.

- Scroll to **Private keys**
- Click **Generate a private key**
- Download the `.pem` file — keep it secure

#### 4. Note the App ID

On the same settings page, near the top, find the **App ID** (a numeric ID). You'll need this in the workflow.

#### 5. Install the app on your repositories

- Go to the app settings page > **Install App**
- Select your org
- Choose **Only select repositories** and pick both the source and target repos
- Click **Install**

For cross-org setups, install the same app in both orgs. The workflow will generate separate tokens for each — see the workflow examples below.

#### 6. Store credentials

Store the app credentials as **org-level** Actions variables/secrets (Settings > Secrets and variables > Actions) so all repos in the org can access them:

- `PORT_BOT_APP_ID` — the app's numeric ID. Can be stored as an **Actions variable** or **Actions secret** — it's not sensitive, but either works.
- `PORT_BOT_APP_PRIVATE_KEY` — the full contents of the downloaded `.pem` file (including the `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines), stored as an **Actions secret**

The workflow examples below use `${{ secrets.PORT_BOT_APP_ID }}`. If you store the App ID as a variable instead, change it to `${{ vars.PORT_BOT_APP_ID }}`.

## Step 2: Add secrets

Go to your **source** repository's Settings > Secrets and variables > Actions and add:

| Secret                         | Required | Purpose                                     |
| ------------------------------ | -------- | ------------------------------------------- |
| `PORT_BOT_LLM_API_KEY`         | Always   | Anthropic API key                           |
| `PORT_BOT_GITHUB_TOKEN`        | Option A | Single PAT for source reads + target writes |
| `PORT_BOT_SOURCE_GITHUB_TOKEN` | Option B | Source repo read token                      |
| `PORT_BOT_TARGET_GITHUB_TOKEN` | Option B | Target repo write token                     |
| `PORT_BOT_APP_PRIVATE_KEY`     | Option C | GitHub App private key                      |

| Variable          | Required | Purpose       |
| ----------------- | -------- | ------------- |
| `PORT_BOT_APP_ID` | Option C | GitHub App ID |

## Step 3: Create the workflow file

In your **source** repository, create `.github/workflows/port-bot.yml`.

Pick the template that matches your auth method:

### Option A: Single PAT

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
                  target-repo: your-org/target-repo
```

### Option B: Split PATs

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
                  source-github-token: ${{ secrets.PORT_BOT_SOURCE_GITHUB_TOKEN }}
                  target-github-token: ${{ secrets.PORT_BOT_TARGET_GITHUB_TOKEN }}
                  target-repo: your-org/target-repo
```

### Option C: Org-owned GitHub App (same org)

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
            - name: Generate GitHub App token
              id: app-token
              uses: actions/create-github-app-token@v1
              with:
                  app-id: ${{ secrets.PORT_BOT_APP_ID }}
                  private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
                  repositories: source-repo,target-repo

            - uses: superbuilders/repo-port-bot@v1
              with:
                  llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
                  github-token: ${{ steps.app-token.outputs.token }}
                  target-repo: your-org/target-repo
```

Replace `source-repo,target-repo` with your actual repo names (without the org prefix).

### Option C: Org-owned GitHub App (cross-org)

When source and target repos are in different orgs:

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
      - name: Generate source repo token
        id: source-token
              uses: actions/create-github-app-token@v1
              with:
                  app-id: ${{ secrets.PORT_BOT_APP_ID }}
                  private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
                  owner: source-org
                  repositories: source-repo

            - name: Generate target repo token
              id: target-token
              uses: actions/create-github-app-token@v1
              with:
                  app-id: ${{ secrets.PORT_BOT_APP_ID }}
                  private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
                  owner: target-org
          repositories: target-repo

      - uses: superbuilders/repo-port-bot@v1
        with:
          llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
          source-github-token: ${{ steps.source-token.outputs.token }}
          target-github-token: ${{ steps.target-token.outputs.token }}
          target-repo: target-org/target-repo
```

## Step 4: Configure behavior

The bot works with just the three required inputs (`llm-api-key`, a token, `target-repo`). Everything below is optional and can be added incrementally as you see results.

### Action inputs

Add these to your workflow's `with:` block:

```yaml
with:
    # ... required inputs ...
    validation-commands: |
        bun run check
        bun run test
    path-mappings: '{"src/": "packages/client/src/"}'
    naming-conventions: 'camelCase -> snake_case'
    prompt: 'The target repo is a Python SDK. Use idiomatic Python patterns.'
    model: claude-sonnet-4-6
    max-attempts: 3
    log-level: info
```

| Input                   | Default             | Description                                                                    |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `target-default-branch` | `main`              | Default branch for target repo checkout and PR base                            |
| `validation-commands`   | —                   | Newline-separated commands to validate the agent's work                        |
| `path-mappings`         | `{}`                | JSON object mapping source paths to target paths                               |
| `naming-conventions`    | —                   | Naming convention guidance (e.g., `camelCase -> snake_case`)                   |
| `prompt`                | —                   | Additional custom instructions for the agent                                   |
| `skip-port-bot-json`    | `false`             | Skip fetching `port-bot.json` from source repo                                 |
| `commit-sha`            | —                   | Override the source commit SHA to process (defaults to the workflow event SHA) |
| `model`                 | `claude-sonnet-4-6` | Claude model to use                                                            |
| `max-attempts`          | `3`                 | Maximum execution attempts before opening a draft PR                           |
| `max-turns`             | `50`                | Maximum Claude SDK turns per attempt                                           |
| `max-budget-usd`        | —                   | Optional budget cap (USD) per attempt                                          |
| `log-level`             | `info`              | Minimum log level (`error`, `warn`, `info`, `debug`)                           |

### Config file

For config that should live alongside your source code, add one of these supported files to the source repo:

- `port-bot.json`
- `.port-bot.json`
- `repo-port-bot.json`
- `.repo-port-bot.json`
- `.github/port-bot.json`
- `.github/repo-port-bot.json`

Example:

```json
{
	"target": "your-org/target-repo",
	"validation": ["bun run check", "bun run test"],
	"mapping": {
		"src/": "packages/client/src/"
	},
	"ignore": ["scripts/**", "*.config.*"],
	"conventions": {
		"naming": "camelCase -> snake_case"
	},
	"prompt": "The target repo is a Python SDK. Use idiomatic Python patterns."
}
```

All fields are optional. The engine fetches the first matching supported config file from the source repo at the merge commit SHA using this precedence order:

1. `port-bot.json`
2. `.port-bot.json`
3. `repo-port-bot.json`
4. `.repo-port-bot.json`
5. `.github/port-bot.json`
6. `.github/repo-port-bot.json`

If none of these files exists, nothing breaks.

**How action inputs and the config file interact:**

- Action inputs take precedence when both specify the same field.
- `ignore` patterns are only configurable via the config file, not as an action input.
- Set `skip-port-bot-json: true` in the workflow to disable config-file fetching entirely.

## Step 5: Verify the first run

1. Merge a small, representative PR in the source repo.
2. Go to the Actions tab — the "Port Bot" workflow should appear and run.
3. Check the run's **Summary** tab for the outcome, decision reason, timing, and links.

**Expected outcomes:**

| Source change                                   | Expected outcome                                  |
| ----------------------------------------------- | ------------------------------------------------- |
| Docs-only (`README.md`, `docs/`)                | Skipped — source PR gets a comment explaining why |
| CI/config-only (`.github/`, `Makefile`)         | Skipped — source PR gets a comment explaining why |
| Code that exists in both repos                  | PR opened in target repo                          |
| Complex change the classifier can't safely port | Issue opened in target repo tagged `needs-human`  |

If validation commands are configured and they fail after retries, the bot opens a **draft PR** instead of a ready-for-review PR.

## Troubleshooting

### Token permissions too narrow

The GitHub token needs write access to the target repo for PR creation and git push. A read-only token fails at the delivery stage. Look for a `403` or push rejection in the Actions log.

### No validation commands configured

Without validation commands, the bot opens PRs as ready-for-review even if the code doesn't compile. Adding at least one command (type check, lint, test) is strongly recommended. Without validation, the PR body omits the "Validation & diagnostics" section.

### Wrong `target-repo` format

Must be `owner/name` (e.g., `acme/python-sdk`). A bare repo name without the owner fails at input parsing.

### Cross-org access denied

A single PAT or single installation token may not have cross-org access. Use split tokens (Option B) or generate separate installation tokens per org (Option C cross-org).

### Bot doesn't run on merge

The workflow triggers on `push` to `main` (or your default branch). If the merged PR doesn't push to the branch specified in the workflow trigger, the bot won't run. Check that the `branches` filter matches your default branch.

### Skipping everything unexpectedly

The bot skips changes that are docs-only, config-only, or labeled `no-port`. If your PR has mixed content but the heuristics still skip it, check whether all changed files match the built-in skip patterns or the `ignore` patterns in your config file.
