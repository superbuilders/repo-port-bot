# Setup Commands

Allow `port-bot.json` consumers to define commands that run once after the target repo is cloned, before the agent or validation runs.

## Problem

The engine clones the target repo into a temp directory (`git clone --depth 1`) and immediately hands it to the agent. For repos that need a dependency install step before tools like pyright or pytest can work, there's no hook to run it.

Real example: `timeback-dev-python` is a uv workspace monorepo. Pyright needs all workspace packages installed in editable mode to resolve cross-package imports. Locally, `uv sync --all-packages` does this. But in the port bot's temp clone, no install ever happens, so pyright reports ~45 `reportMissingImports` errors that don't exist locally or in CI. The agent sees these as "pre-existing" and works around them, but it's noisy and can mask real failures.

The same problem applies to any target repo that needs `npm install`, `bun install`, `pip install -e .`, etc. before validation commands can run cleanly.

## Proposed design

Add an optional `setup` field to `port-bot.json`:

```json
{
  "target": "superbuilders/timeback-dev-python",
  "setup": ["uv sync --all-packages"],
  "validation": ["just check-ci"],
  ...
}
```

`setup` is an ordered array of shell commands. The engine runs them sequentially in the target working directory after cloning, before the deterministic phase. If any command fails, the run aborts with a clear error (not a stalled PR).

Key differences from `validation`:

| Aspect           | `setup`                 | `validation`              |
| ---------------- | ----------------------- | ------------------------- |
| When it runs     | Once, after clone       | After each agent attempt  |
| Failure behavior | Abort the entire run    | Retry with agent feedback |
| Purpose          | Prepare the environment | Verify correctness        |

## Implementation sketch

### Config layer

`PortBotJsonConfig` and `PluginConfig` get a new `setup?: string[]` / `setupCommands: string[]` field. The resolver defaults it to `[]`. The decoder accepts it from `port-bot.json`.

### Execution layer

Reuse `runValidationCommands` (or extract a shared `runCommands` helper) to execute setup commands in the target working directory. Run them in `runPort` after `cloneTargetRepo` returns but before `executeDeterministic`. On failure, return early with a descriptive error rather than entering the agent loop.

### Agent prompt

Include setup command output in the agent's context so it can see what was installed and what versions are available. This helps the agent make correct choices (e.g., knowing which Python version or which packages are available).

## Alternatives considered

**Inline in validation** — `"validation": ["uv sync --all-packages && just check-ci"]`. Works today with no engine changes, but runs the install on every retry attempt (wasteful), and the install output pollutes validation logs making real failures harder to find.

**Dockerfile / container approach** — have the target repo provide a dev container that already has everything installed. Overkill for the current architecture and would require Docker-in-Docker or a container runtime in the action.
