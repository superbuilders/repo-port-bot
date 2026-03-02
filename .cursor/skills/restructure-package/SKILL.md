---
name: restructure-package
description: Reorganize files within a package or feature directory for better maintainability and scannability. Use when the user says file structure feels disorganized, asks to reorganize or restructure a directory, or wants to improve how files are grouped within a package.
---

# Restructure Package

Reorganize source files within a package or feature directory so the structure reflects the actual domain boundaries, is consistent, and is easy to scan.

## Process

### 1. Audit

- List all source files in the target directory.
- Read every file. Understand what each does, what it imports, and what imports it.
- Identify the distinct **concerns** (e.g. HTTP transport, normalization, auth, webhook handling).
- Note any duplicated code across files.

### 2. Propose

Present a before/after tree to the user. Call out:

- Which files move where and why.
- Any files being split or merged.
- Any shared code being extracted.
- What stays at the root and why.

**Do not proceed until the user confirms.**

### 3. Implement

1. Create new directories.
2. `mv` files rather than regenerating — preserves git history.
3. Create barrel `index.ts` files for each new directory.
4. Fix all import paths in moved files.
5. Fix all import paths in files that reference moved files (operations, tests, root barrel).
6. Extract duplicated helpers into a shared `utils.ts` (or similar).
7. Delete original files only after the new ones are in place.

### 4. Verify

Run the project's check and test commands. Every test that passed before must still pass.

## Principles

**Group by concern, not by file type.** A folder should represent a domain boundary (e.g. `auth/`, `webhook/`, `api/`), not a category (e.g. `types/`, `helpers/`).

**Be consistent.** If one concern gets a folder, similar concerns at the same level should too. Don't leave one as a folder and another as a flat file unless the asymmetry is justified.

**Don't over-slice.** A folder with a single non-barrel file is a smell. If a concern is one file, it can stay at root.

**Types stay at root.** A single `types.ts` as the source of truth for the package's public types avoids circular imports and is easy to find.

**Barrel files are mandatory for subdirectories.** Every new folder gets an `index.ts` that re-exports its public API. Consumers import from the barrel, not from internal files.

**Deduplicate on sight.** If the same helper appears in multiple files, extract it to a shared module during the restructure.

**Root barrel reflects the public API.** The package's `src/index.ts` imports from subdirectory barrels and re-exports the package's public surface. Internal wiring stays hidden.

## Common Groupings

These are patterns, not rules. Let the code tell you what belongs together.

| Concern           | Typical folder    | Contains                                       |
| ----------------- | ----------------- | ---------------------------------------------- |
| HTTP / API client | `api/` or `http/` | Request helpers, error types, response parsing |
| Auth              | `auth/`           | Client factories, token management             |
| Normalization     | `normalize/`      | Raw payload → domain shape mappers             |
| Webhook handling  | `webhook/`        | Signature verification, event parsing          |
| Policy / rules    | `policy/`         | Validation, access control                     |
| Persistence       | `store/` or `db/` | Queries, migrations                            |

Files that commonly stay at root:

- `types.ts` — package-wide type definitions
- `utils.ts` — small shared helpers
- The primary export file when the package has a single "star" (e.g. `backend.ts`)
