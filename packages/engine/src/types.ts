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
	 * Git patch content for this file, used by the agent for prompt construction.
	 * May be absent for binary files or when the diff is too large.
	 */
	patch?: string

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
	 * Associated PR metadata. Expected to be present for all PR-merge triggers.
	 * May be absent if the push event cannot be resolved to a PR (e.g., direct
	 * push to default branch, or GitHub API lookup failure). When absent, the
	 * decision stage should treat the run as `NEEDS_HUMAN`.
	 */
	pullRequest?: PullRequestRef

	/**
	 * Normalized changed files list.
	 */
	files: ChangedFile[]
}

/**
 * Partially-specified plugin config used when merging built-in action inputs
 * with `port-bot.json`. All fields are optional so the resolver can fill gaps.
 */
export type PartialPluginConfig = Partial<PluginConfig> & {
	targetRepo?: Partial<RepoRef>
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
}

// ---------------------------------------------------------------------------
// Agent provider contract
// ---------------------------------------------------------------------------

/**
 * Recorded tool invocation from the agent for observability and debugging.
 */
export interface ToolCallEntry {
	/**
	 * Tool name as registered with the provider, for example `write_file`.
	 */
	toolName: string

	/**
	 * Arguments passed to the tool (schema varies per tool).
	 */
	input: unknown

	/**
	 * Value returned by the tool (schema varies per tool).
	 */
	output: unknown

	/**
	 * Wall-clock duration of the tool call in milliseconds.
	 */
	durationMs?: number
}

/**
 * Streaming message kinds emitted by an agent provider during execution.
 */
export type AgentMessageKind = 'thinking' | 'tool_start' | 'tool_end' | 'text'

/**
 * Structured streaming message emitted during one agent attempt.
 */
export interface AgentMessage {
	/**
	 * Message category for routing to observability sinks.
	 */
	kind: AgentMessageKind

	/**
	 * Free-form message text (thinking or assistant text blocks).
	 */
	text?: string

	/**
	 * Tool name for tool lifecycle messages.
	 */
	toolName?: string

	/**
	 * Tool input payload at start time for context-rich logging.
	 */
	toolInput?: Record<string, unknown>

	/**
	 * Tool call duration in milliseconds when available.
	 */
	durationMs?: number
}

/**
 * Everything the agent provider needs to perform one edit attempt.
 *
 * The orchestrator constructs this before each call to the provider. On
 * retries, `previousAttempts` carries validation errors and touched files
 * from earlier attempts so the provider can adjust its strategy.
 */
export interface AgentInput {
	/**
	 * Changed files with patch content from the source PR.
	 */
	files: ChangedFile[]

	/**
	 * Absolute path to the target repo working directory on disk.
	 */
	targetWorkingDirectory: string

	/**
	 * Optional absolute path to a local source repo checkout at the merge commit.
	 */
	sourceWorkingDirectory?: string

	/**
	 * Optional absolute path to a full git diff patch file from the source repo.
	 */
	diffFilePath?: string

	/**
	 * Resolved plugin config (path mappings, conventions, prompt).
	 */
	pluginConfig: PluginConfig

	/**
	 * Previous attempt results provided on retries so the agent can learn
	 * from validation failures. Empty array on the first attempt.
	 */
	previousAttempts: ExecutionAttempt[]

	/**
	 * Optional callback for streaming provider messages during execution.
	 */
	onMessage?: (message: AgentMessage) => void
}

/**
 * What the agent provider returns after one edit attempt.
 *
 * The provider only produces edits — it never runs validation commands.
 * The orchestrator validates the result and decides whether to retry.
 */
export interface AgentOutput {
	/**
	 * Files the agent created or modified in the target repo.
	 */
	touchedFiles: string[]

	/**
	 * Whether the agent believes its edits fully address the port.
	 */
	complete: boolean

	/**
	 * Optional free-form notes about uncertainty, trade-offs, or skipped items.
	 */
	notes?: string

	/**
	 * Ordered log of tool calls made during this attempt. Collected from the
	 * SDK message stream (e.g., `SDKAssistantMessage` tool_use blocks) and
	 * used for observability, cost tracking, and post-hoc debugging.
	 */
	toolCallLog: ToolCallEntry[]
}

/**
 * Contract that any agentic backend must implement. The engine depends on
 * this interface; implementations are swappable without touching
 * orchestration code.
 *
 * @see agent-loop.md "Provider interface" section
 */
export interface AgentProvider {
	/**
	 * Execute one port attempt given the provided context.
	 *
	 * @param input - Context for this attempt including source diff and retry history.
	 * @returns Agent output with touched files, completion status, and tool call log.
	 */
	executePort(input: AgentInput): Promise<AgentOutput>
}

// ---------------------------------------------------------------------------
// GitHub adapter contracts
// ---------------------------------------------------------------------------

/**
 * Minimal result shape for a created GitHub pull request.
 */
export interface CreatedPullRequest {
	/**
	 * Pull request number in the target repository.
	 */
	number: number

	/**
	 * Canonical HTML URL for linking and traceability.
	 */
	url: string
}

/**
 * Minimal result shape for a created GitHub issue.
 */
export interface CreatedIssue {
	/**
	 * Issue number in the target repository.
	 */
	number: number

	/**
	 * Canonical HTML URL for linking and traceability.
	 */
	url: string
}

/**
 * Read-only GitHub operations needed by the engine.
 *
 * The engine depends on this interface; the action layer provides an
 * Octokit-backed implementation. Tests supply in-memory fakes.
 */
export interface GitHubReader {
	/**
	 * List merged pull requests associated with a commit SHA.
	 *
	 * @param owner - Repository owner.
	 * @param repo - Repository name.
	 * @param commitSha - Merge commit SHA.
	 * @returns Pull request refs ordered by association (first is best match).
	 */
	listPullRequestsForCommit(
		owner: string,
		repo: string,
		commitSha: string,
	): Promise<PullRequestRef[]>

	/**
	 * List changed files for a pull request with full pagination.
	 *
	 * @param owner - Repository owner.
	 * @param repo - Repository name.
	 * @param pullRequestNumber - PR number.
	 * @returns Normalized changed files.
	 */
	listChangedFiles(owner: string, repo: string, pullRequestNumber: number): Promise<ChangedFile[]>

	/**
	 * Fetch a single file's UTF-8 content at a given ref.
	 *
	 * @param owner - Repository owner.
	 * @param repo - Repository name.
	 * @param path - Repository-relative file path.
	 * @param ref - Git ref (branch, tag, or SHA).
	 * @returns Decoded file content, or `undefined` when the file does not exist.
	 */
	getFileContent(
		owner: string,
		repo: string,
		path: string,
		ref: string,
	): Promise<string | undefined>
}

/**
 * Write-side GitHub operations needed by the engine.
 *
 * Mirrors `GitHubReader` in philosophy: the engine depends on this
 * interface, not on Octokit internals. Implementations are swappable
 * for testing and alternative hosting platforms.
 */
export interface GitHubWriter {
	/**
	 * Create a pull request in the target repository.
	 *
	 * @param params - Pull request creation parameters.
	 * @returns Created pull request metadata.
	 */
	createPullRequest(params: {
		owner: string
		repo: string
		title: string
		body: string
		head: string
		base: string
		draft: boolean
	}): Promise<CreatedPullRequest>

	/**
	 * Create an issue in the target repository.
	 *
	 * @param params - Issue creation parameters.
	 * @returns Created issue metadata.
	 */
	createIssue(params: {
		owner: string
		repo: string
		title: string
		body: string
		labels: string[]
	}): Promise<CreatedIssue>

	/**
	 * Add labels to an issue or pull request.
	 *
	 * @param params - Label parameters.
	 */
	addLabels(params: {
		owner: string
		repo: string
		issueNumber: number
		labels: string[]
	}): Promise<void>

	/**
	 * Create a comment on an issue or pull request.
	 *
	 * @param params - Comment parameters.
	 * @returns Created comment HTML URL, or `undefined` on failure.
	 */
	createComment(params: {
		owner: string
		repo: string
		issueNumber: number
		body: string
	}): Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// Validation & execution
// ---------------------------------------------------------------------------

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

	/**
	 * Tool calls made by the agent during this attempt, for observability.
	 */
	toolCallLog: ToolCallEntry[]
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

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Terminal outcome from the delivery stage before mapping to `PortRunOutcome`.
 *
 * - `pr_opened`: target PR created and ready for review
 * - `draft_pr_opened`: target draft PR created (validation failed after retries)
 * - `needs_human`: follow-up issue created in target repo
 * - `skipped`: no delivery performed (PORT_NOT_REQUIRED)
 */
export type DeliveryOutcome = 'pr_opened' | 'draft_pr_opened' | 'needs_human' | 'skipped'

/**
 * Output contract of the delivery stage.
 */
export interface DeliveryResult {
	/**
	 * Delivery outcome that the pipeline maps to a `PortRunOutcome`.
	 */
	outcome: DeliveryOutcome

	/**
	 * Created target pull request URL when a PR was opened.
	 */
	targetPullRequestUrl?: string

	/**
	 * Created follow-up issue URL for NEEDS_HUMAN outcomes.
	 */
	followUpIssueUrl?: string
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

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

	/**
	 * Total wall-clock duration of the run in milliseconds, measured from
	 * pipeline start to terminal outcome.
	 */
	durationMs: number

	/**
	 * Optional stage timing breakdown captured during orchestration.
	 */
	stageTimings?: {
		contextMs?: number
		configMs?: number
		decisionMs?: number
		executeMs?: number
		deliverMs?: number
		notifyMs?: number
	}
}
