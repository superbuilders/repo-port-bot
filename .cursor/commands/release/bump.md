# Bump and Release

Commit all staged/unstaged changes, bump the version, and push.

## Process

1. Review changes with `git status` and `git diff`
2. Bump the version:

```bash
bun bump --release patch --yes
```

Use `patch` by default. If the user specifies a different level (minor, major), use that instead.

## Notes

- `bumpp` handles the version bump in package.json, git commit, git tag, and git push in one step
- The push triggers the release workflow which publishes to npm automatically
- If there are no uncommitted changes, skip straight to the bump
