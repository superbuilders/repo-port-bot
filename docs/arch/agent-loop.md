# Agent Loop

How the engine executes a port once the decision stage returns `PORT_REQUIRED`.

This is the least-determined part of the system. Use this doc to capture decisions as they're made and flag open questions.

## Execution environment

The agent loop runs inside a **GitHub Actions runner** triggered by the source repo workflow.

### What's known

- **Ephemeral filesystem**: fresh checkout each run, no persistent state between runs.
- **Two repos on disk**: source (read-only, pinned to merge SHA) and target (writable, checked out at default branch).
- **Available tooling**: whatever the runner image provides (git, common runtimes) plus anything the workflow installs.
- **Network access**: can reach GitHub API, package registries, LLM provider endpoints.
- **Time budget**: GitHub Actions has a per-job timeout (default 6 hours, configurable). The engine should enforce its own shorter timeout.

### What's undetermined

- **Runner image**: stock `ubuntu-latest` or a custom image with pre-installed toolchains?
- **Language runtimes**: does the target repo need Node, Python, Rust, etc. for validation? Who installs them — the workflow or the engine?
- **Engine timeout**: what's a reasonable wall-clock limit per run? (Agent loop + retries must fit within it.)
- **Resource constraints**: memory/CPU limits on the runner, especially if the LLM agent is doing heavy context loading.
- **Local vs. CI execution**: should the engine also work when run locally (e.g., `bun run port --pr 123`) or is CI the only supported path?

## Current understanding

### Inputs

The agent receives a `PortContext` containing:

- Source PR metadata (title, body, URL, labels)
- Diff summary and changed files list
- Resolved plugin config:
    - target repo ref
    - path mappings (source path → target path)
    - naming conventions
    - validation commands
    - custom prompt/instructions

### Workspace

- Target repo is checked out at latest default branch.
- Port branch is created: `port/<sourceRepo>/<sourcePrNumber>-<shortSha>`
- Source repo is available read-only at the merged commit SHA.

### Execution cycle

```
          ┌─────────────────────┐
          │  Read source diff   │
          │  + mapping context  │
          └────────┬────────────┘
                   │
                   ▼
          ┌─────────────────────┐
          │  Apply edits in     │
          │  target repo        │
          └────────┬────────────┘
                   │
                   ▼
          ┌─────────────────────┐
     ┌───▶│  Run validations    │
     │    └────────┬────────────┘
     │             │
     │        pass │  fail
     │             │    │
     │             ▼    ▼
     │          done  ┌─────────────────┐
     │                │  Read errors    │
     │                │  + attempt fix  │
     │                └────────┬────────┘
     │                         │
     │            under limit? │
     │              yes ───────┘
     │               no
     │                │
     │                ▼
     │           give up
     └────────────────┘
```

### Retry policy

- Max attempts: configurable (default TBD).
- Each attempt: agent reads validation output, applies targeted fix, reruns.
- On exhaustion: execution returns `success: false` with `failureReason`.

### Output

An `ExecutionResult` containing:

- `success` boolean
- Per-attempt history (files touched, validation results, notes)
- Final touched files list
- Failure reason if applicable

## Provider interface

The engine does not call an agent framework directly. Instead, the execution layer depends on an `AgentProvider` interface — a contract that any agentic backend can implement.

```typescript
interface AgentProvider {
	executePort(input: AgentInput): Promise<AgentOutput>
}
```

### Why

- **Swappable backends**: Claude Agent SDK today, Codex or another framework tomorrow — without touching orchestration code.
- **Testable**: mock the provider in tests to verify retry logic, summary rendering, PR creation, etc. without hitting a real LLM.
- **Clean boundary**: the engine owns the "what" (retry policy, validation, workspace, delivery). The provider owns the "how" (prompt format, tool wiring, model interaction).

### Contract shape

**`AgentInput`** — everything the provider needs to do one attempt:

- Source diff and changed files
- Target repo working directory path
- Resolved plugin config (path mappings, conventions, prompt)
- Previous attempt context on retries (validation errors, what was already tried)

**`AgentOutput`** — what the provider returns per attempt:

- Files touched
- Whether the agent believes edits are complete
- Optional notes / uncertainty flags
- Raw tool call log (for observability)

The orchestrator (`execute-port.ts`) calls the provider, runs validation itself, and decides whether to retry based on the retry policy. The provider never runs validation commands — it only produces edits.

### v1 provider: `claude-agent-sdk-typescript`

Anthropic's own Claude Code Action uses this SDK. It handles multi-turn tool use, streaming, and context management.

Open questions specific to this provider:

- Single conversation across retries or fresh conversation per attempt?
- How much source context fits in the initial prompt vs. tool-retrieved on demand?
- Which Claude model? (Cost vs. quality tradeoff per run.)

### Future providers

Potential alternatives that would implement the same interface:

- OpenAI Codex / Responses API
- Open-source agent frameworks (e.g. `mastra`, `vercel/ai`)
- A "dry-run" provider that outputs a plan without applying edits

## Open questions

### Provider integration

- Single conversation across retries or fresh context per attempt?
- How much source context fits in the initial prompt vs. tool-retrieved on demand?
- Which Claude model for v1? (Cost vs. quality per run.)
- Should the provider return structured edits or just mutate the filesystem directly?

### Tool surface

What tools does the agent get?

- File read / write / list
- Search (ripgrep)
- Shell command execution (validation commands, git)
- Git operations (commit, status, diff)

How are tools sandboxed? Can the agent run arbitrary shell commands or only the configured validation set?

### Prompt construction

- How are plugin mapping rules and conventions injected into the prompt?
- Is the source diff included verbatim or summarized?
- How does the prompt change between first attempt and retry attempts?
- Does the agent see full validation output or a truncated/parsed version?

### Scope of edits

- Does the agent commit after each attempt or only on final success?
- Can the agent create new files in the target repo or only modify existing ones?
- How does the agent handle cases where source files have no target mapping?

### Validation strategy

- Are validation commands run sequentially or can they run in parallel?
- Does the agent see all validation failures at once or stop at the first?
- Should partial validation success (some commands pass, some fail) influence retry behavior?

### Quality signals

- How do we measure whether the agent's edits are "correct" beyond validation passing?
- Should the agent produce a confidence score or uncertainty notes?
- Is there a complexity threshold where the agent should bail early rather than attempt?

## Decisions log

Record decisions here as they're made.

### 2026-03-01 — Agent provider interface

- **Question**: Should the engine couple directly to an agent framework or abstract it?
- **Decision**: Define an `AgentProvider` interface. The engine depends on the interface; implementations are swappable.
- **Rationale**: Keeps orchestration testable without a real LLM, and allows future provider swaps (Codex, open-source, dry-run) without touching core logic.

### 2026-03-01 — v1 agent framework

- **Question**: Which agent SDK for v1?
- **Decision**: `claude-agent-sdk-typescript`
- **Rationale**: Anthropic's own Claude Code Action uses it. Handles multi-turn tool use, streaming, and context management out of the box.

### Decision template

- **Date**:
- **Question**:
- **Decision**:
- **Rationale**:
