# Release to Main

Push the current branch to `dev` and open a PR to merge into `main`. The release workflow runs automatically when the PR is merged.

## Process

1. Push the current branch to `dev`:

```bash
git push origin dev
```

2. Generate the PR title and body:

```bash
bun scripts/release-notes.ts dev
```

This outputs JSON with `title` and `body` fields, parsed from the conventional commits in `origin/main..dev`.

3. Create the PR using the generated title and body (or print the URL if one already exists):

```bash
gh pr create --base main --head dev --title "<title>" --body "<body>"
```

4. Merge the PR (no squash — preserve commit history):

```bash
gh pr merge --merge
```

5. Stay on `dev`. Do not checkout `main` locally.

## Why a PR instead of local merge

The release workflow commits the built action bundle (`packages/action/dist/index.cjs`) directly to `main`. This means `origin/main` diverges from any local `main` checkout after every release. A PR merges server-side, avoiding local/remote conflicts entirely.

## What happens automatically

The release workflow (`.github/workflows/release.yml`) triggers on push to `main`:

1. Install, check, test
2. Build the action bundle (`packages/action/dist/index.cjs`)
3. Commit the bundle if changed
4. Force-update the `v1` tag

Users reference `@v1` which always points to the latest release build on `main`.

## Notes

- There are no version bumps or npm publishing — this repo ships a GitHub Action, not a package
- The `v1` tag is force-updated on every release, so users always get the latest
- If the workflow has already created a `v1` tag, you don't need to create one manually
