# Creating Pull Requests

## Details

- **Head branch:** Determine via `git branch --show-current`
- **Base branch:** Determine via `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`. Only ask the user if it seems incorrect.

## Title

Concise, descriptive summary of the PR's main purpose.

## Body

Two required sections:

```
This PR:
- First change description
- Second change description

Notes:
- Additional context or considerations
```

Link related issues at the end: `Closes #123` or `Fixes #123`.

## Example

```
Title: Add deploy workflows with OIDC authentication

Body:
This PR:
- Replaces CI/PR workflows with deploy and preview workflows
- Adds OIDC authentication using IAM roles (no static AWS credentials)
- Configures staging environment for dev branch deployments

Notes:
- IAM roles created: project-github-production, project-github-dev, project-github-pr
- GitHub environments created: production, staging, preview

Closes #42
```
