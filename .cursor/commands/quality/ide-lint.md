# IDE Lint

Checks for linter and diagnostic errors (TypeScript, ESLint, etc.) reported by the IDE.

# Usage

Use the `read_lints` tool to check for errors in files you have edited or are about to edit.

- Pass specific file paths to check those files: `read_lints({ paths: ["path/to/file.ts"] })`
- Pass a directory path to check all files in that directory
- Omit paths to check all files in the workspace (use sparingly)

Call this after making edits to verify no type errors or linting issues were introduced.
