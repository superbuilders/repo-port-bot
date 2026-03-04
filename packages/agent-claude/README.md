# @repo-port-bot/agent-claude

Claude Agent SDK adapter for the repo-port-bot `AgentProvider` interface.

## Installation

```bash
bun add @repo-port-bot/agent-claude
```

## Usage

```typescript
import { ClaudeAgentProvider } from '@repo-port-bot/agent-claude'
import { executePort } from '@repo-port-bot/engine'

const provider = new ClaudeAgentProvider({
	model: 'claude-sonnet-4-6',
	maxTurns: 50,
})

const result = await executePort({
	agentProvider: provider,
	context,
	targetWorkingDirectory: '/path/to/target/repo',
})
```

Pipeline-level example:

```typescript
import { ClaudeAgentProvider } from '@repo-port-bot/agent-claude'
import { runPort } from '@repo-port-bot/engine'

const provider = new ClaudeAgentProvider()

const result = await runPort({
	octokit,
	agentProvider: provider,
	sourceRepo: { owner: 'acme', name: 'source-repo', defaultBranch: 'main' },
	commitSha: 'abc1234',
	targetWorkingDirectory: '/path/to/target/repo',
	builtInConfig: {
		targetRepo: { owner: 'acme', name: 'target-repo', defaultBranch: 'main' },
		validationCommands: ['bun run check'],
		pathMappings: { 'src/': 'src/' },
	},
})
```

## API

- `ClaudeAgentProvider`
- `ClaudeProviderOptions`

## Configuration

`ClaudeProviderOptions`:

- `model?: string` (default: `claude-sonnet-4-6`)
- `maxTurns?: number` (default: `50`)
- `maxBudgetUsd?: number`
- `apiKey?: string` (falls back to `ANTHROPIC_API_KEY`)

Runtime behavior:

- Uses Claude Agent SDK `query()` for one attempt
- Enables built-in tools: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`
- Runs in `bypassPermissions` mode for non-interactive CI usage
- Collects `toolCallLog` and touched files (`Edit`/`Write`) for engine observability
