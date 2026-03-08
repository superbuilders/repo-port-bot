# GitHub App Authentication

How the bot could move from personal access tokens to a GitHub App for authentication and authorization.

## Problem with PATs

v1 authentication uses personal access tokens (PATs). This works but has friction:

- **Token ownership**: PATs are tied to a personal GitHub account. If that person leaves the org, the token breaks. Org admins have no visibility into which PATs exist or what they access.
- **Permission granularity**: a classic PAT grants permissions across all repos the user can access. Fine-grained PATs improve this but still require manual scoping per repo pair.
- **Cross-org access**: when source and target repos are in different orgs, split tokens are needed. Each org's admin must independently grant access, and there is no unified view of what the bot can reach.
- **Secret rotation**: PATs expire or get revoked. The maintainer must manually rotate secrets in every source repo that uses the bot.
- **Onboarding cost**: the first-time-setup story requires creating a PAT, scoping its permissions correctly, and adding it as a secret. This is the most error-prone step in onboarding.

## What a GitHub App provides

A GitHub App is installed at the org level and granted access to specific repositories with fine-grained permissions. The app authenticates via short-lived installation tokens that GitHub generates on demand.

Benefits:

- **Org-level management**: admins install the app once, choose which repos it can access, and control permissions centrally. No personal tokens, no individual account dependency.
- **Automatic token lifecycle**: installation tokens are short-lived (1 hour) and generated per-request. No secrets to rotate.
- **Fine-grained permissions**: the app requests exactly the permissions it needs (contents, pull requests, issues) and nothing more. Permissions are visible in the app's settings page.
- **Cross-org support**: the app can be installed on repos in different orgs independently. Each org admin approves installation for their repos.
- **Auditability**: GitHub logs app activity under the app identity, not a personal account. Easier to trace what the bot did.

## Permissions needed

| Repository  | Permission            | Reason                                           |
| ----------- | --------------------- | ------------------------------------------------ |
| Source repo | `contents:read`       | Clone source at merge SHA, read `port-bot.json`  |
| Source repo | `pull_requests:read`  | List PRs for commit, read PR metadata and labels |
| Source repo | `pull_requests:write` | Post source PR notification comments             |
| Target repo | `contents:write`      | Push port branch with agent edits                |
| Target repo | `pull_requests:write` | Create/update target PRs, add labels             |
| Target repo | `issues:write`        | Create needs-human follow-up issues, add labels  |

Note: source repo needs `pull_requests:write` (not just `read`) because the bot posts notification comments on source PRs. GitHub's permission model requires write access to create comments on pull requests.

## Two paths: first-party app vs bring-your-own app

The key implementation distinction is simple:

- If the consumer provides the app credentials, no hosted service is needed.
- If the consumer should have the seamless "install the app and the action just works" experience, some trusted backend must mint installation tokens on behalf of the action.

### Path 1: First-party app (the seamless experience)

This is how Claude Code Action works. Anthropic publishes the official Claude GitHub App. The consumer experience is:

1. Go to `github.com/apps/claude`, click Install, pick your repos.
2. Use the action. No token inputs needed — the action authenticates internally.

Under the hood, Claude Code Action requests a GitHub OIDC token, sends it to an Anthropic-hosted exchange endpoint (`api.anthropic.com/api/github/github-app-token-exchange`), and receives an installation token scoped to the repos where the app is installed. The consumer never sees a token.

This hosted exchange is not required for GitHub App auth in general. It is required for this specific UX: the action needs a way to get an installation token without the consumer storing the app's private key in workflow secrets.

For repo-port-bot, the equivalent would be:

1. We publish a "Repo Port Bot" GitHub App with the permissions listed above.
2. We host a lightweight token exchange service (could be a Cloudflare Worker or similar).
3. Our action requests an OIDC token, exchanges it against our endpoint, and gets an installation token.
4. The consumer's workflow is just:

```yaml
- uses: superbuilders/repo-port-bot@v1
  with:
      llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
      target-repo: acme/target-repo
```

No `github-token` input at all. The app handles auth.

**What this requires from us:**

- Register and maintain a GitHub App (permissions, webhook config, marketplace listing)
- Host a token exchange service that validates OIDC tokens and returns installation tokens
- Handle OIDC validation (verify the token came from a GitHub Actions runner for a repo where our app is installed)
- Revoke installation tokens after each run (Claude Code Action does this in a cleanup step)

**Consumer experience:** Install the app, add one workflow file, done. Same as every other GitHub App they've used.

### Path 2: Bring-your-own app (consumer-managed)

For orgs that can't install third-party apps (policy restrictions, air-gapped environments), the consumer creates their own GitHub App and generates tokens in their workflow using GitHub's official `actions/create-github-app-token` action:

```yaml
# Consumer creates their own GitHub App and stores its credentials as secrets
- name: Generate GitHub App token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
      app-id: ${{ secrets.PORT_BOT_APP_ID }}
      private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
      repositories: source-repo,target-repo

- uses: superbuilders/repo-port-bot@v1
  with:
      github-token: ${{ steps.app-token.outputs.token }}
      llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
      target-repo: acme/target-repo
```

**What this requires from us:** Nothing. The action already accepts `github-token` — an installation token works identically to a PAT. We just document the pattern.

**Consumer experience:** More setup (create app, generate private key, configure secrets, add the pre-step), but fully self-contained with no dependency on our hosted infrastructure.

For cross-org setups, the consumer generates two tokens — one per org — mirroring the current split-token PAT pattern:

```yaml
- name: Source repo token
  id: source-token
  uses: actions/create-github-app-token@v1
  with:
      app-id: ${{ secrets.PORT_BOT_APP_ID }}
      private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
      owner: source-org
      repositories: source-repo

  - name: Target repo token
    id: target-token
    uses: actions/create-github-app-token@v1
    with:
      app-id: ${{ secrets.PORT_BOT_APP_ID }}
      private-key: ${{ secrets.PORT_BOT_APP_PRIVATE_KEY }}
      owner: target-org
      repositories: target-repo

- uses: superbuilders/repo-port-bot@v1
  with:
      source-github-token: ${{ steps.source-token.outputs.token }}
      target-github-token: ${{ steps.target-token.outputs.token }}
      llm-api-key: ${{ secrets.PORT_BOT_LLM_API_KEY }}
      target-repo: target-org/target-repo
```

## Recommendation

The recommended next step is an **org-owned, consumer-managed GitHub App**:

- the company creates and owns the app
- the company stores `PORT_BOT_APP_ID` and `PORT_BOT_APP_PRIVATE_KEY` in org-level Actions secrets / variables
- the consumer workflow uses `actions/create-github-app-token`
- repo-port-bot receives the resulting installation token through the existing `github-token` or split-token inputs

This removes the biggest PAT footgun — authentication tied to one employee's personal account — without requiring us to host any privileged backend.

In other words:

- **Near-term recommendation**: Path 2, ideally with an org-owned app rather than a personal app
- **Long-term UX target**: Path 1, if we later decide the seamless "install the app and the action just works" experience is worth the infrastructure cost

### Engine changes

None for either path. The engine depends on `GitHubReader` and `GitHubWriter` interfaces, not on Octokit or token details.

### Action changes for Path 2

None. The existing `github-token` and split token inputs already accept installation tokens.

### Action changes for Path 1

- Add OIDC token request (via `@actions/core` `getIDToken()`)
- Add token exchange against our hosted endpoint
- Add installation token revocation in a cleanup step
- Make `github-token` optional (currently required) when the first-party app is installed
- Detect which auth mode to use: first-party app (OIDC available) vs PAT (explicit token provided) vs bring-your-own-app (explicit token provided)

## Open questions

- Is the token exchange service worth the hosting/maintenance cost, or is Path 2 good enough for now?
- Should the first-party app be published to the GitHub Marketplace for discoverability?
- Installation tokens expire after 1 hour. Port runs typically complete in under 10 minutes, but should the action handle token refresh for unusually long runs?
- For Path 1, should cross-org setups require the app installed in both orgs, or can a single installation with broad access cover both?
