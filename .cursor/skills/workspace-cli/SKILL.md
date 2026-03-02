---
name: workspace-cli
description: Manages hbot monorepo packages using the workspace CLI in non-interactive command-line mode. Use when creating, removing, listing, cleaning packages, or running checks from terminal-only agents.
---

# Workspace CLI

Use this skill for package-management tasks in this repository.

## Scope

- Repo: `hbot`
- CLI entry: `bun workspace ...` (from root `package.json` script)
- Workspace root: `packages/*`
- Agent constraint: command-line only, no interactive prompts

## Non-Interactive Rule

Always use explicit subcommands and arguments. Do not run bare `bun workspace` because it opens an interactive menu.

Preferred commands:

- Create package: `bun workspace create <name>`
- Remove package (no prompt): `bun workspace remove <name> --yes`
- List packages: `bun workspace list`
- Clean artifacts: `bun workspace clean`
- Clean including `node_modules`: `bun workspace clean --all`

## Behavior Notes

- `create` fails in non-interactive mode if no name is provided.
- `remove` fails in non-interactive mode if no name is provided.
- `remove --yes` skips confirmation and is safe for automation.
- `create` copies template files from `scripts/workspace/cli/.template`.

## Recommended Workflow

1. Run the workspace command with explicit args.
2. If package structure changes, run `bun run build`.
3. Validate with `bun run check`.

## Examples

See [examples.md](examples.md) for copy/paste command sequences.
