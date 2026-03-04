import { fetchPortBotJson } from '../config/fetch-port-bot-json.ts'
import { resolvePluginConfig } from '../config/resolve-plugin-config.ts'
import { decide } from '../decision/decide.ts'
import { executePort } from '../execution/execute-port.ts'
import { deliverResult } from '../github/deliver.ts'
import { readSourceContext } from '../github/read-source-context.ts'
import { joinNonEmptyLines, toErrorMessage } from '../utils.ts'

import type { Octokit } from '@octokit/rest'

import type { PortBotJsonConfig } from '../config/types.ts'
import type {
	AgentProvider,
	ExecutionResult,
	PluginConfig,
	PortContext,
	PortDecision,
	PortRunResult,
	RepoRef,
	SourceChange,
} from '../types.ts'

type PartialPluginConfig = Partial<PluginConfig> & {
	targetRepo?: Partial<RepoRef>
}

interface RunPortStageOverrides {
	readSourceContext: typeof readSourceContext
	fetchPortBotJson: typeof fetchPortBotJson
	resolvePluginConfig: typeof resolvePluginConfig
	decide: typeof decide
	executePort: typeof executePort
	deliverResult: typeof deliverResult
}

interface RunPortOptions {
	octokit: Octokit
	agentProvider: AgentProvider
	sourceRepo: RepoRef
	commitSha: string
	builtInConfig?: PartialPluginConfig
	portBotJson?: PortBotJsonConfig | string
	skipPortBotJson?: boolean
	targetWorkingDirectory: string
	maxAttempts?: number
	/**
	 * Internal testing hook for replacing stage implementations.
	 *
	 * @internal
	 */
	stageOverrides?: Partial<RunPortStageOverrides>
}

const ENGINE_ERROR_SIGNAL = 'engine-error'
const MIN_DURATION_MS = 1

/**
 * Measure elapsed runtime in milliseconds.
 *
 * @param startedAtMs - Start timestamp.
 * @returns Elapsed duration.
 */
function getDurationMs(startedAtMs: number): number {
	return Math.max(MIN_DURATION_MS, Date.now() - startedAtMs)
}

/**
 * Build a fallback decision when the pipeline fails before decision stage output exists.
 *
 * @param message - Error message.
 * @returns Decision describing engine failure.
 */
function buildEngineFailureDecision(message: string): PortDecision {
	return {
		kind: 'NEEDS_HUMAN',
		reason: `Engine failure before decision completed: ${message}`,
		signals: [ENGINE_ERROR_SIGNAL],
	}
}

/**
 * Render final run summary from stage outputs.
 *
 * @param input - Summary composition input.
 * @param input.outcome - Terminal outcome.
 * @param input.decision - Decision stage output.
 * @param input.execution - Optional execution result.
 * @param input.targetPullRequestUrl - Optional created target PR URL.
 * @param input.followUpIssueUrl - Optional created follow-up issue URL.
 * @param input.errorMessage - Optional engine failure message.
 * @returns Human-readable summary text.
 */
function renderSummary(input: {
	outcome: PortRunResult['outcome']
	decision: PortDecision
	execution?: ExecutionResult
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	errorMessage?: string
}): string {
	const { decision, execution, followUpIssueUrl, outcome, targetPullRequestUrl } = input

	switch (outcome) {
		case 'skipped_not_required': {
			return `Skipped: ${decision.reason}`
		}
		case 'needs_human': {
			return (
				joinNonEmptyLines(
					[
						`Needs human review: ${decision.reason}`,
						followUpIssueUrl && `Issue: ${followUpIssueUrl}`,
					],
					' ',
				) ?? `Needs human review: ${decision.reason}`
			)
		}
		case 'pr_opened': {
			return (
				joinNonEmptyLines(
					[
						targetPullRequestUrl && `Port PR opened: ${targetPullRequestUrl}`,
						execution && `(${String(execution.attempts)} attempts)`,
					],
					' ',
				) ?? 'Port PR opened.'
			)
		}
		case 'draft_pr_opened': {
			return (
				joinNonEmptyLines(
					[
						targetPullRequestUrl &&
							`Draft PR opened (stalled): ${targetPullRequestUrl}.`,
						execution?.failureReason,
					],
					' ',
				) ?? 'Draft PR opened (stalled).'
			)
		}
		case 'failed': {
			return `Engine failure: ${input.errorMessage ?? decision.reason}`
		}
		default: {
			return 'Port run completed.'
		}
	}
}

/**
 * Run the full pipeline orchestration for one source merge commit.
 *
 * @param options - Pipeline options.
 * @returns Terminal run result with duration and delivery metadata.
 */
export async function runPort(options: RunPortOptions): Promise<PortRunResult> {
	const startedAtMs = Date.now()
	const runId = crypto.randomUUID()
	const startedAt = new Date(startedAtMs).toISOString()
	let decision: PortDecision | undefined = undefined

	const stages: RunPortStageOverrides = {
		readSourceContext: options.stageOverrides?.readSourceContext ?? readSourceContext,
		fetchPortBotJson: options.stageOverrides?.fetchPortBotJson ?? fetchPortBotJson,
		resolvePluginConfig: options.stageOverrides?.resolvePluginConfig ?? resolvePluginConfig,
		decide: options.stageOverrides?.decide ?? decide,
		executePort: options.stageOverrides?.executePort ?? executePort,
		deliverResult: options.stageOverrides?.deliverResult ?? deliverResult,
	}

	try {
		const sourceChange: SourceChange = await stages.readSourceContext({
			octokit: options.octokit,
			owner: options.sourceRepo.owner,
			repo: options.sourceRepo.name,
			commitSha: options.commitSha,
		})
		const resolvedPortBotJson =
			options.portBotJson === undefined && options.skipPortBotJson !== true
				? await stages.fetchPortBotJson({
						octokit: options.octokit,
						owner: options.sourceRepo.owner,
						repo: options.sourceRepo.name,
						ref: options.commitSha,
					})
				: options.portBotJson

		const pluginConfig: PluginConfig = stages.resolvePluginConfig({
			builtInConfig: options.builtInConfig,
			portBotJson: resolvedPortBotJson,
		})

		const context: PortContext = {
			runId,
			startedAt,
			sourceRepo: options.sourceRepo,
			sourceChange,
			pluginConfig,
		}

		decision = stages.decide(context)

		if (decision.kind === 'PORT_NOT_REQUIRED') {
			return {
				runId,
				outcome: 'skipped_not_required',
				decision,
				summary: renderSummary({ outcome: 'skipped_not_required', decision }),
				durationMs: getDurationMs(startedAtMs),
			}
		}

		if (decision.kind === 'NEEDS_HUMAN') {
			const delivery = await stages.deliverResult({
				octokit: options.octokit,
				context,
				decision,
				targetWorkingDirectory: options.targetWorkingDirectory,
			})

			return {
				runId,
				outcome: 'needs_human',
				decision,
				followUpIssueUrl: delivery.followUpIssueUrl,
				summary: renderSummary({
					outcome: 'needs_human',
					decision,
					followUpIssueUrl: delivery.followUpIssueUrl,
				}),
				durationMs: getDurationMs(startedAtMs),
			}
		}

		const execution = await stages.executePort({
			agentProvider: options.agentProvider,
			context,
			maxAttempts: options.maxAttempts,
			targetWorkingDirectory: options.targetWorkingDirectory,
		})
		const delivery = await stages.deliverResult({
			octokit: options.octokit,
			context,
			decision,
			execution,
			targetWorkingDirectory: options.targetWorkingDirectory,
		})

		if (delivery.outcome !== 'pr_opened' && delivery.outcome !== 'draft_pr_opened') {
			throw new Error(
				`Unexpected delivery outcome for PORT_REQUIRED decision: ${delivery.outcome}`,
			)
		}

		const outcome = delivery.outcome

		return {
			runId,
			outcome,
			decision,
			execution,
			targetPullRequestUrl: delivery.targetPullRequestUrl,
			summary: renderSummary({
				outcome,
				decision,
				execution,
				targetPullRequestUrl: delivery.targetPullRequestUrl,
			}),
			durationMs: getDurationMs(startedAtMs),
		}
	} catch (error) {
		const errorMessage = toErrorMessage(error)
		const failureDecision = decision ?? buildEngineFailureDecision(errorMessage)

		return {
			runId,
			outcome: 'failed',
			decision: failureDecision,
			summary: renderSummary({
				outcome: 'failed',
				decision: failureDecision,
				errorMessage,
			}),
			durationMs: getDurationMs(startedAtMs),
		}
	}
}
