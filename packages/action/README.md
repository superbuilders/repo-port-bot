# @repo-port-bot/action

Bundles the root GitHub Action runtime and wires workflow inputs to the engine pipeline.

## What it does

- Parses action inputs (including flexible token model)
- Clones and configures the target repo working directory
- Creates source/target Octokit clients
- Runs `runPort()` with `ClaudeAgentProvider`
- Publishes GitHub Action outputs (`run-id`, `outcome`, `pr-url`, `issue-url`, `summary`)

## Build

```bash
bun run build
```

This writes the bundled JavaScript entrypoint to `dist/index.js`, which is referenced by the root `action.yml`.
