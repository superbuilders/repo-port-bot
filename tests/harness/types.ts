import type { PortBotJsonConfig } from '../../packages/engine/src/config/types.ts'
/**
 * Shared types for the scenario test harness.
 */
import type { AgentProvider, GitHubWriter, SourceChange } from '../../packages/engine/src/index.ts'

/**
 * Local repo paths created by `createRepos`.
 */
export interface RepoSetup {
	targetDir: string
	bareRemoteDir: string
	sourceDir: string
}

/**
 * Tracked pull request in the in-memory writer.
 */
export interface TrackedPr {
	title: string
	body: string
	head: string
	base: string
	draft: boolean
	labels: string[]
}

/**
 * Tracked issue in the in-memory writer.
 */
export interface TrackedIssue {
	title: string
	body: string
	labels: string[]
}

/**
 * Tracked comment in the in-memory writer.
 */
export interface TrackedComment {
	issueNumber: number
	body: string
}

/**
 * In-memory record of all GitHub mutations performed during a scenario.
 */
export interface GitHubState {
	pullRequests: TrackedPr[]
	issues: TrackedIssue[]
	labels: { issueNumber: number; labels: string[] }[]
	comments: TrackedComment[]
}

/**
 * Predetermined file edit for the scripted agent.
 */
export interface ScriptedEdit {
	path: string
	content: string
}

/**
 * Options for the scripted agent provider.
 */
export interface ScriptedAgentOptions {
	edits?: ScriptedEdit[]
}

/**
 * Options for running a scenario test.
 */
export interface RunScenarioOptions {
	sourceChange: SourceChange
	repos: RepoSetup
	writer: GitHubWriter
	agentProvider?: AgentProvider
	portBotJson?: PortBotJsonConfig | string
	maxAttempts?: number
}

/**
 * Parsed PR body with named sections for targeted assertions.
 */
export interface ParsedPrBody {
	raw: string
	rationale: string
	diagnostics: string
	workLog: string
	sections: Map<string, string>
}
