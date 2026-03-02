# Creating Release Pull Requests

## Details

- **Head branch:** The development/integration branch (e.g., `dev`, `develop`, or the default branch)
- **Base branch:** The production branch (e.g., `main`, `production`)
- **Title format:** `Release: YYYY-MM-DD`

Determine the correct branches by inspecting the repository's branch structure and conventions.

## Process

1. Compare the head and base branches to understand what's being released:

```bash
git log <base>..<head> --oneline
```

2. Read the actual diffs for merged PRs — do NOT rely on PR titles alone
3. Write a summary grounded in what the code actually does — name specific types, methods, schemas, etc.
4. Show preview to user before creating

## Body

```markdown
## Summary

[2-3 sentences: the most important changes and why they matter]

### Changes

- **`package-or-scope`**: Concrete description — name specific types, methods, schemas
- [Additional bullets as needed — one per package or logical group]

## PRs Included

- #123 Title of PR
- #124 Title of PR
```

## Guidelines

- Be specific — name types, methods, schemas, endpoints that changed
- Keep it terse but accurate (~20-30 lines total)
- No emojis or exclamation marks
- Group related changes only when it improves clarity
