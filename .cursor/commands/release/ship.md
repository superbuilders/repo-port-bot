# Release to Main

Push the current branch to `dev` and merge into `main`. The release workflow runs automatically on push to `main`.

## Process

1. Push the current branch to `dev`:

```bash
git push origin dev
```

2. Merge `dev` into `main`:

```bash
git checkout main && git merge dev --no-ff && git push origin main
```

3. Switch back to `dev`:

```bash
git checkout dev
```

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
