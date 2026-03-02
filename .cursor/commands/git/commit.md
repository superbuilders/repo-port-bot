# Commit

Only `git add -A` if needed.

## Context

Before writing the commit message, understand what's being committed:

- If you made the changes in this session, use that context
- Otherwise, run `git diff --staged` or `git diff` to review changes
- If you're having trouble understanding something, compare against the default branch

**Important:** Describe the final state relative to the base branch, not changes between commits within the same branch.

Example: You're on a feature branch. Earlier you added `list()` returning `Paginator<T>`. Later you changed it to return `Promise<T[]>`. When committing:

- Wrong: "Changed list() from Paginator<T> to Promise<T[]>"
- Right: "list() returns Promise<T[]> for idiomatic usage"

The base branch never had `list()`; returning `Paginator<T>` was an intermediate state in your branch. Describe what exists now vs what existed before the branch, not the journey within the branch.

## Format

### Title

```
type(scope): concise imperative description
```

### Body

Proportionate to change size: small changes get a line or two, large changes get detailed bullets/examples.

- **Fixes:** problem → solution
- **Features:** bullet list; before/after for UX changes

Title under 72 chars. No fluff.

## Examples

### Small (~1-20 lines)

Good:

```
chore(cli): remove unused test script

Not used; simplifies package.json.
```

Bad (no body):

```
chore(cli): remove unused test script
```

Bad (over-explained):

```
chore(cli): remove unused test script

This commit removes the test script from package.json because it was
not being used anywhere in the codebase. The script was originally
added for testing purposes but is no longer needed...
```

### Medium (~20-100 lines)

Good:

```
fix(editor): sync canvas nodes when data prop changes

useNodesState only uses initial value on first render. Add useEffect
to update nodes when data loads asynchronously.
```

Bad (too terse):

```
fix(editor): fix canvas bug
```

### Large (100-500 lines)

Good:

```
feat(api): add dedicated filter flags for list commands

Replace --filter string syntax with ergonomic per-resource flags:

  # Before
  cli users list --filter "role='teacher'"

  # After
  cli users list --role teacher

- Resource-specific flags: --status, --role, --email, --name, etc.
- Text fields use partial matching by default
- Add --exact flag for exact matching
```

Bad (missing detail):

```
feat(api): add filter flags

Added some new flags for filtering.
```

### Very Large (500+ lines, multi-scope)

For commits spanning multiple packages/features, group by scope:

Good:

```
feat(api): type-safe filtering and sorting

BREAKING CHANGE: list() now returns Promise<T[]> instead of Paginator<T>

**Client SDK**
- list() returns Promise<T[]> for idiomatic usage
- stream() returns Paginator<T> for lazy pagination
- Add type-safe 'where' clause with object shorthand syntax
- Add type-safe 'sort' field with autocomplete

**CLI**
- Update list handlers to use new API
- Add dedicated filter flags per resource

**Documentation**
- Add architecture doc for pagination API
- Update examples across packages
```

Bad (wall of bullets):

```
feat(api): updates

- Changed list
- Added stream
- Updated CLI
- Fixed tests
- Added docs
- Changed types
- Updated examples
...
```
