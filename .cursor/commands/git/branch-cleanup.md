# Branch Cleanup

Clean up local branches that have been merged and deleted on GitHub.

## When to Use

After squash-merging PRs to `dev`, the remote branches are deleted but local branches accumulate. Run this periodically to clean them up.

## Process

1. **Fetch and prune remote tracking branches:**

```bash
git fetch --prune
```

2. **List local branches that no longer exist on remote:**

```bash
git branch -vv | grep ': gone]' | awk '{print $1}'
```

3. **Delete those branches (after confirming with user):**

```bash
git branch -d <branch-name>
```

Use `-D` (force) only if `-d` fails due to unmerged changes the user confirms are safe to delete.

4. **Switch to `dev` if currently on a deleted branch:**

```bash
git checkout dev
git pull
```

## Safety

- Never delete `main` or `dev`
- Always show the list of branches before deleting
- Ask for confirmation before bulk deletion
- Use `-d` (safe delete) by default, only `-D` with explicit user approval

## Example Output

```
Branches to clean up:
  - feature/add-user-filtering
  - fix/empty-response-handling
  - docs/update-readme

Delete these 3 branches?
```
