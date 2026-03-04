import type * as core from '@actions/core'
import type * as github from '@actions/github'
import type {
	AgentProvider,
	GitHubReader,
	GitHubWriter,
	deliverResult,
	readSourceContext,
	RepoRef,
	runPort,
} from '@repo-port-bot/engine'
import type { LogLevel, Logger } from '@repo-port-bot/logger'

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
	logLevel: LogLevel
	effectiveSourceToken: string
	effectiveTargetToken: string
}

export interface CloneTargetRepoOptions {
	repo: ParsedRepo
	defaultBranch: string
	token: string
}

export interface CloneSourceRepoOptions {
	repo: ParsedRepo
	commitSha: string
	token: string
}

export interface CloneSourceRepoResult {
	sourceWorkingDirectory: string
	diffFilePath: string
}

export interface CloneTargetRepoDependencies {
	createTempDirectory(prefix: string): Promise<string>
	runCommand(input: {
		command: string[]
		workingDirectory?: string
	}): Promise<{ exitCode: number; stderr: string; stdout: string }>
}

export interface CloneSourceRepoDependencies {
	createTempDirectory(prefix: string): Promise<string>
	runCommand(input: {
		command: string[]
		workingDirectory?: string
	}): Promise<{ exitCode: number; stderr: string; stdout: string }>
	writeFile(path: string, content: string): Promise<void>
}

export type CloneTargetRepoFn = (
	options: CloneTargetRepoOptions,
	dependencies?: Partial<CloneTargetRepoDependencies>,
) => Promise<string>

export type CloneSourceRepoFn = (
	options: CloneSourceRepoOptions,
	dependencies?: Partial<CloneSourceRepoDependencies>,
) => Promise<CloneSourceRepoResult>

export interface ParseActionInputsDependencies {
	getInput(name: string, options?: core.InputOptions): string
	context: typeof github.context
}

export type ParseActionInputsFn = (
	dependencies?: Partial<ParseActionInputsDependencies>,
) => ParsedActionInputs

export interface RunActionDependencies {
	parseInputs: ParseActionInputsFn
	cloneSourceRepo: CloneSourceRepoFn
	cloneTargetRepo: CloneTargetRepoFn
	createReader(token: string): GitHubReader
	createWriter(token: string): GitHubWriter
	createAgentProvider(input: {
		apiKey: string
		model: string
		maxTurns: number
		maxBudgetUsd?: number
	}): AgentProvider
	createLogger(level: LogLevel): Logger
	runPort: typeof runPort
	readSourceContext: typeof readSourceContext
	deliverResult: typeof deliverResult
}
