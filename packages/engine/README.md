# @repo-port-bot/engine

Core automation engine. Takes a merged PR, decides whether to port it, applies the equivalent change in a target repo, and opens a PR.

## Pipeline

```
Source PR merged
      │
      ▼
  ┌────────┐     PortContext
  │ Gather │────────────────┐
  └────────┘                │
                            ▼
                    ┌────────────┐     PortDecision
                    │   Decide   │──────────────────┐
                    └────────────┘                  │
                          │ NEEDS_HUMAN             │ REQUIRED
                          ▼                         ▼
                    open issue              ┌─────────────┐     ExecutionResult
                                            │   Execute   │─────────────────┐
                                            └─────────────┘                 │
                                                  ▲ retry                   │
                                                  │ loop                    ▼
                                            ┌───────────┐            ┌─────────────┐
                                            │ Validate  │            │   Deliver   │
                                            └───────────┘            └─────────────┘
                                                                            │
                                                                            ▼
                                                                    PR in target repo
```

## Stage contracts

Each stage has an explicit input/output type. Modules compose through these — never by reaching into each other's internals.

| Stage   | Input                          | Output            | Owner                   |
| ------- | ------------------------------ | ----------------- | ----------------------- |
| Gather  | PR event payload               | `PortContext`     | `pipeline/` + `github/` |
| Decide  | `PortContext`                  | `PortDecision`    | `decision/`             |
| Execute | `PortContext` + `PortDecision` | `ExecutionResult` | `execution/`            |
| Deliver | `ExecutionResult`              | `PortRunResult`   | `pipeline/` + `github/` |

### Key types (`types.ts`)

- **`PortContext`** — source PR metadata, diff, resolved plugin config
- **`PortDecision`** — `PORT_REQUIRED | PORT_NOT_REQUIRED | NEEDS_HUMAN` + reason string
- **`ExecutionResult`** — success/failure, retry count, touched files, validation logs
- **`PortRunResult`** — final outcome + PR/issue URLs + summary payload

## Architectural boundaries

### Policy vs. side-effects

Policy modules contain business rules and are pure / easily testable:

- `decision/heuristics.ts`, `execution/execute-port.ts` (retry logic)

Side-effect modules talk to external systems:

- `github/read-source-context.ts`, `github/deliver.ts`

This matters because you can test all decision and retry logic without touching GitHub or an LLM.

### Orchestration is thin

`pipeline/run-port.ts` and `execution/execute-port.ts` are orchestrators — they call other modules in sequence and handle errors. They should stay thin. If an orchestrator is getting complex, logic is leaking in.

### Agent provider is external

The engine depends on the `AgentProvider` interface, not on any specific agent SDK. The v1 implementation lives in `packages/agent-claude/`.

## Retry behavior

The execution orchestrator treats validation failures like a developer would: read the error, pass it back to the agent, re-run. Max attempts are configurable (default 3). Only after exhausting retries does the engine fall back to opening a draft PR with `port-stalled` label.

## Config resolution

1. If `portBotJson` is not provided by the caller, `runPort()` auto-fetches
   `port-bot.json` from the source repo root at the merge commit SHA via
   GitHub Contents API (404 → skip, other errors → warn and continue)
2. Decode via `port-bot-json.decoder.ts` (runtime validation with `decoders.cc`)
3. Accept optional built-in config from the caller (e.g. action inputs)
4. Merge (built-in takes precedence, `port-bot.json` fills gaps)
5. Validate merged config via `resolve-plugin-config.ts`
6. Return resolved `PluginConfig` as part of `PortContext`
