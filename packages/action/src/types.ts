import type * as core from '@actions/core'
import type * as github from '@actions/github'
import type { Octokit } from '@octokit/rest'
import type {
	AgentProvider,
	deliverResult,
	readSourceContext,
	RepoRef,
	runPort,
} from '@repo-port-bot/engine'

export interface ParsedRepo {
	owner: string
	name: string
}

export interface ParsedActionInputs {
	sourceRepo: RepoRef
	commitSha: string
	targetRepo: ParsedRepo
	targetDefaultBranch: string
	llmApiKey: string
	model: string
	maxAttempts: number
	maxTurns: number
	maxBudgetUsd?: number
	validationCommands: string[]
	pathMappings: Record<string, string>
	namingConventions?: string
	prompt?: string
	skipPortBotJson: boolean
	effectiveSourceToken: string
	effectiveTargetToken: string
}

export interface CloneTargetRepoOptions {
	repo: ParsedRepo
	defaultBranch: string
	token: string
}

export interface CloneTargetRepoDependencies {
	createTempDirectory(prefix: string): Promise<string>
	runCommand(input: {
		command: string[]
		workingDirectory?: string
	}): Promise<{ exitCode: number; stderr: string; stdout: string }>
}

export type CloneTargetRepoFn = (
	options: CloneTargetRepoOptions,
	dependencies?: Partial<CloneTargetRepoDependencies>,
) => Promise<string>

export interface ParseActionInputsDependencies {
	getInput(name: string, options?: core.InputOptions): string
	context: typeof github.context
}

export type ParseActionInputsFn = (
	dependencies?: Partial<ParseActionInputsDependencies>,
) => ParsedActionInputs

export interface RunActionDependencies {
	parseInputs: ParseActionInputsFn
	cloneTargetRepo: CloneTargetRepoFn
	createOctokit(token: string): Octokit
	createAgentProvider(input: {
		apiKey: string
		model: string
		maxTurns: number
		maxBudgetUsd?: number
	}): AgentProvider
	runPort: typeof runPort
	readSourceContext: typeof readSourceContext
	deliverResult: typeof deliverResult
}
