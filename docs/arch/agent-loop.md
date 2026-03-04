# Agent Loop

How the engine executes a port once the decision stage returns `PORT_REQUIRED`.

This is the least-determined part of the system. Use this doc to capture decisions as they're made and flag open questions.

## Execution environment

The agent loop runs inside a **GitHub Actions runner** triggered by the source repo workflow.

- **Ephemeral filesystem**: fresh checkout each run, no persistent state between runs.
- **Source repo on disk**: shallow-cloned at the merge commit SHA into a temp directory. The agent can `Read`/`Grep`/`Glob` source files for context beyond the diff.
- **Target repo on disk**: shallow-cloned at the target's default branch into a separate temp directory, with bot git identity configured. This is the agent's `cwd` where edits happen.
- **Diff artifact**: `git diff HEAD~1` is computed from the source clone and saved to a file (`port-diff.patch`) in the source directory. Always available for agent reference regardless of size.
- **Available tooling**: stock `ubuntu-latest` runner plus whatever the workflow installs before the action step.
- **Network access**: GitHub API, package registries, LLM provider endpoints.
- **Budget control**: the Claude Agent SDK accepts `maxBudgetUsd` and `maxTurns` per attempt; the engine enforces `maxAttempts` across retries.

### Still undetermined

- **Language runtimes**: does the target repo need Node, Python, Rust, etc. for validation? Who installs them — the workflow or the engine?
- **Local execution**: should the engine also work when run locally (e.g., `bun run port --pr 123`) or is CI the only supported path?

## Current understanding

### Inputs

The agent receives:

- Source PR metadata (title, body, URL, labels)
- Changed files list with stats (from GitHub API)
- Path to the saved diff file (`port-diff.patch`) for full diff content
- Path to the source repo clone for exploratory reads
- Resolved plugin config:
    - target repo ref
    - path mappings (source path → target path)
    - naming conventions
    - validation commands
    - custom prompt/instructions

### Workspace

- **Source repo**: shallow-cloned at the merge commit SHA. Read-only reference for the agent. Contains `port-diff.patch` (full `git diff HEAD~1` output).
- **Target repo**: shallow-cloned at the default branch. Agent's `cwd` — all edits happen here.
- Port branch is created at delivery time: `port/<sourceRepo>/<sourcePrNumber>-<shortSha>`

The agent uses absolute paths to read source files and the diff, and relative paths (from `cwd`) to edit target files.

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

- Max attempts: configurable (default 3).
- Each attempt: agent receives `previousAttempts` feedback (validation errors, touched files), applies targeted fix, reruns.
- Conversation model: fresh per attempt (new `query()` call each retry).
- Working directory: incremental (no reset between attempts; each builds on previous edits).
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

### v1 provider: `@repo-port-bot/agent-claude`

Uses `@anthropic-ai/claude-agent-sdk` via the `ClaudeAgentProvider` class.

- **Conversation model**: fresh per attempt (new `query()` call each retry).
- **Tools**: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash` — built-in SDK tools.
- **Permissions**: runs in `bypassPermissions` mode for non-interactive CI usage.
- **Observability**: `ToolCallEntry[]` collected via SDK `PreToolUse`/`PostToolUse` hooks; touched files tracked from `Edit`/`Write` tool inputs.
- **Default model**: `claude-sonnet-4-6` (configurable via action input).
- **Budget**: `maxTurns` (default 50) and optional `maxBudgetUsd` per attempt.

### Future providers

Potential alternatives that would implement the same interface:

- OpenAI Codex / Responses API
- Open-source agent frameworks (e.g. `mastra`, `vercel/ai`)
- A "dry-run" provider that outputs a plan without applying edits

## Open questions

### Tool sandboxing

- Can the agent run arbitrary shell commands or only the configured validation set?
- Should `Bash` tool access be restricted to read-only commands + validation commands?

### Prompt tuning

- Does the agent see full validation output or a truncated/parsed version on retry?

### Quality signals

- How do we measure whether the agent's edits are "correct" beyond validation passing?
- Is there a complexity threshold where the agent should bail early rather than attempt?

## Decisions log

Record decisions here as they're made.

### 2026-03-01 — Agent provider interface

- **Question**: Should the engine couple directly to an agent framework or abstract it?
- **Decision**: Define an `AgentProvider` interface. The engine depends on the interface; implementations are swappable.
- **Rationale**: Keeps orchestration testable without a real LLM, and allows future provider swaps (Codex, open-source, dry-run) without touching core logic.

### 2026-03-01 — v1 agent framework

- **Question**: Which agent SDK for v1?
- **Decision**: `@anthropic-ai/claude-agent-sdk` via `ClaudeAgentProvider`.
- **Rationale**: Anthropic's own Claude Code Action uses it. Handles multi-turn tool use, streaming, and context management out of the box.

### 2026-03-03 — Conversation model

- **Question**: Single conversation across retries or fresh context per attempt?
- **Decision**: Fresh per attempt (new `query()` call each retry).
- **Rationale**: Simpler state management; `previousAttempts` feedback provides retry context without carrying stale conversation history.

### 2026-03-03 — Working directory reset

- **Question**: Reset target repo between attempts or build incrementally?
- **Decision**: Incremental (no reset); each attempt builds on previous edits.
- **Rationale**: Avoids re-doing successful work; agent receives `previousAttempts` to understand what already happened.

### 2026-03-03 — Commit strategy

- **Question**: Commit after each attempt or only on final state?
- **Decision**: One commit per run on the final working tree state (both success and exhaustion).
- **Rationale**: Keeps git history clean; delivery always creates exactly one commit regardless of attempt count.

### 2026-03-03 — Validation policy

- **Question**: Run all validation commands or stop on first failure?
- **Decision**: Sequential execution, stop on first failing command.
- **Rationale**: Fast feedback for the agent; no point running later commands if an earlier one fails.

### 2026-03-03 — Tool surface

- **Question**: What tools does the agent get?
- **Decision**: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash` (Claude Agent SDK built-ins).
- **Rationale**: Covers file operations, search, and shell access for code exploration and edits. Validation is orchestrator-owned; prompt rules instruct the agent not to run validation commands directly.

### 2026-03-03 — Source repo access

- **Date**: 2026-03-03
- **Question**: Should the agent get source context only via API patches in the prompt, or have disk access to the source repo?
- **Decision**: Clone source repo at the merge commit SHA. Compute `git diff HEAD~1` and save to `port-diff.patch`. Agent gets both the diff file and the full source clone for exploratory reads.
- **Rationale**: Eliminates GitHub API patch truncation, lets the agent explore context beyond the diff (imports, tests, adjacent files), and reduces prompt bloat by letting the agent pull what it needs on demand. When source paths are provided, prompts reference the on-disk diff/source paths instead of inlining per-file patches. Inline patch rendering remains only as a fallback for callers that do not provide source paths.

### Decision template

- **Date**:
- **Question**:
- **Decision**:
- **Rationale**:
