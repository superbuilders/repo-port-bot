/**
 * Shared protocol types for the repo-port-bot engine.
 *
 * These types are intentionally "stage-shaped": each pipeline phase has a
 * clear input and output contract so modules can compose without reaching into
 * each other's internals.
 */

/**
 * Supported outcome from the decision stage.
 *
 * - `PORT_REQUIRED`: proceed to execution
 * - `PORT_NOT_REQUIRED`: skip with explanation
 * - `NEEDS_HUMAN`: agent cannot safely decide; request maintainer input
 */
export type PortDecisionKind = 'PORT_REQUIRED' | 'PORT_NOT_REQUIRED' | 'NEEDS_HUMAN'

/**
 * Allowed git-style file change statuses used in diff metadata.
 */
export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/**
 * Canonical repository identifier.
 */
export interface RepoRef {
	/**
	 * Repository owner (org or user), for example `superbuilders`.
	 */
	owner: string

	/**
	 * Repository name, for example `timeback-dev-python`.
	 */
	name: string

	/**
	 * Default branch for the repository.
	 */
	defaultBranch: string
}

/**
 * Normalized metadata for a source pull request.
 */
export interface PullRequestRef {
	/**
	 * Pull request number in the source repository.
	 */
	number: number

	/**
	 * Pull request title as shown in GitHub.
	 */
	title: string

	/**
	 * Pull request body text (can be empty).
	 */
	body: string

	/**
	 * Canonical URL for linking and traceability.
	 */
	url: string

	/**
	 * Labels present on the source PR at processing time.
	 */
	labels: string[]
}

/**
 * File-level diff metadata used by heuristics and prompt construction.
 */
export interface ChangedFile {
	/**
	 * Repository-relative file path.
	 */
	path: string

	/**
	 * Coarse file status from git/GitHub diff metadata.
	 */
	status: ChangedFileStatus

	/**
	 * Lines added in this file according to diff stats.
	 */
	additions: number

	/**
	 * Lines removed in this file according to diff stats.
	 */
	deletions: number

	/**
	 * Optional previous path for renamed files.
	 */
	previousPath?: string
}

/**
 * Source change payload gathered from the triggering event and GitHub APIs.
 */
export interface SourceChange {
	/**
	 * Merge commit SHA that triggered the run.
	 */
	mergedCommitSha: string

	/**
	 * Optional associated PR metadata when available.
	 */
	pullRequest?: PullRequestRef

	/**
	 * Normalized changed files list.
	 */
	files: ChangedFile[]
}

/**
 * Repo-pairing configuration resolved from plugin code and/or `port-bot.json`.
 */
export interface PluginConfig {
	/**
	 * Target repository for generated port pull requests.
	 */
	targetRepo: RepoRef

	/**
	 * Optional glob-like patterns that should be ignored by the decision stage.
	 */
	ignorePatterns: string[]

	/**
	 * Ordered validation commands run in the target repository.
	 */
	validationCommands: string[]

	/**
	 * Source-to-target path mapping hints used by the agent.
	 */
	pathMappings: Record<string, string>

	/**
	 * Optional naming convention hints, for example camelCase -> snake_case.
	 */
	namingConventions?: string

	/**
	 * Optional extra instructions injected into the agent prompt.
	 */
	prompt?: string
}

/**
 * Context passed into both decision and execution stages.
 */
export interface PortContext {
	/**
	 * Stable identifier for the current run.
	 */
	runId: string

	/**
	 * UTC timestamp (ISO-8601) when the run started.
	 */
	startedAt: string

	/**
	 * Source repository where the merge occurred.
	 */
	sourceRepo: RepoRef

	/**
	 * Source change details pulled from GitHub.
	 */
	sourceChange: SourceChange

	/**
	 * Fully resolved plugin configuration used for this run.
	 */
	pluginConfig: PluginConfig
}

/**
 * Output contract of the decision stage.
 */
export interface PortDecision {
	/**
	 * Decision enum controlling downstream behavior.
	 */
	kind: PortDecisionKind

	/**
	 * Human-readable explanation for logs, PR bodies, and debugging.
	 */
	reason: string

	/**
	 * Optional confidence score for classifier-backed decisions (0-1 range).
	 */
	confidence?: number

	/**
	 * Optional machine-readable evidence tags, for example `docs-only`.
	 */
	signals?: string[]
}

/**
 * Per-command result from validation execution.
 */
export interface ValidationCommandResult {
	/**
	 * Exact command string that was executed.
	 */
	command: string

	/**
	 * Whether the command exited successfully.
	 */
	ok: boolean

	/**
	 * Exit status code when available.
	 */
	exitCode?: number

	/**
	 * Captured stdout for troubleshooting.
	 */
	stdout: string

	/**
	 * Captured stderr for troubleshooting.
	 */
	stderr: string

	/**
	 * Command duration in milliseconds.
	 */
	durationMs: number
}

/**
 * Per-attempt execution report for agent edit + validate cycles.
 */
export interface ExecutionAttempt {
	/**
	 * 1-based attempt counter.
	 */
	attempt: number

	/**
	 * Files touched by the agent in this attempt.
	 */
	touchedFiles: string[]

	/**
	 * Validation results for this attempt.
	 */
	validation: ValidationCommandResult[]

	/**
	 * Optional summary of what changed in this attempt.
	 */
	notes?: string
}

/**
 * Final output from the execution stage.
 */
export interface ExecutionResult {
	/**
	 * Whether execution produced a valid, reviewable port branch.
	 */
	success: boolean

	/**
	 * Total attempts performed before success/failure.
	 */
	attempts: number

	/**
	 * Per-attempt diagnostics for debugging and PR summaries.
	 */
	history: ExecutionAttempt[]

	/**
	 * Final touched files list (deduplicated).
	 */
	touchedFiles: string[]

	/**
	 * Final failure explanation when `success` is false.
	 */
	failureReason?: string
}

/**
 * High-level terminal state of a run.
 */
export type PortRunOutcome =
	| 'skipped_not_required'
	| 'needs_human'
	| 'pr_opened'
	| 'draft_pr_opened'
	| 'failed'

/**
 * Output contract for the full pipeline orchestration.
 */
export interface PortRunResult {
	/**
	 * Run identifier copied from `PortContext` for correlation.
	 */
	runId: string

	/**
	 * Terminal outcome of the run.
	 */
	outcome: PortRunOutcome

	/**
	 * Decision returned by the decision stage.
	 */
	decision: PortDecision

	/**
	 * Execution details when the pipeline attempted a port.
	 */
	execution?: ExecutionResult

	/**
	 * Created target PR URL when available.
	 */
	targetPullRequestUrl?: string

	/**
	 * Created issue URL for human follow-up when available.
	 */
	followUpIssueUrl?: string

	/**
	 * Human-readable summary suitable for logs and PR body notes.
	 */
	summary: string
}
