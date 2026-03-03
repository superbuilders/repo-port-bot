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

| Stage   | Input                          | Output            | Owner                                |
| ------- | ------------------------------ | ----------------- | ------------------------------------ |
| Gather  | PR event payload               | `PortContext`     | `run-port.ts` + `adapters/github.ts` |
| Decide  | `PortContext`                  | `PortDecision`    | `decision/`                          |
| Execute | `PortContext` + `PortDecision` | `ExecutionResult` | `execution/`                         |
| Deliver | `ExecutionResult`              | `PortRunResult`   | `run-port.ts` + `adapters/github.ts` |

### Key types (`types.ts`)

- **`PortContext`** — source PR metadata, diff, resolved plugin config
- **`PortDecision`** — `REQUIRED | NOT_REQUIRED | NEEDS_HUMAN` + reason string
- **`ExecutionResult`** — success/failure, retry count, touched files, validation logs
- **`PortRunResult`** — final outcome + PR/issue URLs + summary payload

## Structure

```
src/
  index.ts                # public API surface
  types.ts                # stage contracts (PortContext, PortDecision, etc.)
  errors.ts               # typed error hierarchy
  run-port.ts             # top-level orchestrator (gather → decide → execute → deliver)
  plugin-loader.ts        # load built-in plugin + merge port-bot.json from source repo
  summary.ts              # PR body + run summary rendering
  telemetry.ts            # structured events, step timing, reason codes

  adapters/               # external side-effects (all dumb — no policy)
    github.ts             # read PR data, write branches/PRs/labels
    workspace.ts          # checkout repos, create branches, file workspace
    llm.ts                # thin wrapper over model provider

  decision/               # should we port?
    decide.ts             # orchestrates heuristics → classifier fallback
    heuristics.ts         # fast pure skip rules (docs-only, CI-only, loop detection)
    classify.ts           # LLM classification (uses adapters/llm)

  execution/              # do the port
    execute-port.ts       # orchestrates agent loop + validation retries
    agent.ts              # LLM agent interaction + tool wiring
    validate.ts           # run configured validation commands, parse errors
    retry-policy.ts       # retry/backoff/stop rules (pure — no side effects)
```

## Architectural boundaries

### Policy vs. adapters

Policy modules contain business rules and are pure / easily testable:

- `decision/heuristics.ts`, `execution/retry-policy.ts`

Adapter modules talk to external systems and have no opinions:

- `adapters/github.ts`, `adapters/workspace.ts`, `adapters/llm.ts`

This matters because you can test all decision and retry logic without touching GitHub or an LLM.

### Orchestration is thin

`run-port.ts` and `execution/execute-port.ts` are orchestrators — they call other modules in sequence and handle errors. They should stay thin. If an orchestrator is getting complex, logic is leaking in.

### Directories earn their keep

Each directory groups 3+ files with a shared concern:

- `adapters/` — external integrations (GitHub, workspace, LLM)
- `decision/` — port decision pipeline (heuristics + LLM fallback)
- `execution/` — agent loop + validation + retry

Standalone modules (`plugin-loader`, `summary`, `telemetry`) stay flat at root until they grow.

## Retry behavior

The agent treats validation failures like a developer would: read the error, fix it, re-run. `retry-policy.ts` controls max attempts and backoff. Only after exhausting retries does the engine fall back to opening a draft PR.

## Plugin resolution

1. Check for built-in plugin in `packages/plugins/<name>/`
2. Check for `port-bot.json` in the source repo root
3. Merge (built-in takes precedence, `port-bot.json` overrides specific fields)
4. Validate merged config against schema
5. Return resolved `PluginConfig` as part of `PortContext`
