import { createConsoleLogger } from '@repo-port-bot/logger'

import { fetchPortBotJson } from '../config/fetch-port-bot-json.ts'
import { resolvePluginConfig } from '../config/resolve-plugin-config.ts'
import { buildEngineFailureDecision, decide } from '../decision/decide.ts'
import { executePort } from '../execution/execute-port.ts'
import { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import { readSourceContext } from '../github/read-source-context.ts'
import { renderRunSummary } from '../github/render-body.ts'
import { getDurationMs, toErrorMessage } from '../utils.ts'
import { logFailedOutcome, logOutcome, logStage } from './logging.ts'
import { runNeedsHumanFlow } from './needs-human.ts'
import { runPortRequiredFlow } from './port-required.ts'

import type { Octokit } from '@octokit/rest'
import type { Logger } from '@repo-port-bot/logger'

import type { PortBotJsonConfig } from '../config/types.ts'
import type {
	AgentProvider,
	PartialPluginConfig,
	PluginConfig,
	PortContext,
	PortRunResult,
	RepoRef,
	SourceChange,
} from '../types.ts'

interface RunPortStageOverrides {
	readSourceContext: typeof readSourceContext
	fetchPortBotJson: typeof fetchPortBotJson
	resolvePluginConfig: typeof resolvePluginConfig
	decide: typeof decide
	executePort: typeof executePort
	deliverResult: typeof deliverResult
	commentOnSourcePr: typeof commentOnSourcePr
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
	sourceWorkingDirectory?: string
	diffFilePath?: string
	maxAttempts?: number
	logger?: Logger
	/**
	 * Internal testing hook for replacing stage implementations.
	 *
	 * @internal
	 */
	stageOverrides?: Partial<RunPortStageOverrides>
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
	const logger = options.logger ?? createConsoleLogger('info')

	let decision: PortRunResult['decision'] | undefined = undefined
	let context: PortContext | undefined = undefined
	const stageTimings: NonNullable<PortRunResult['stageTimings']> = {}

	const stages: RunPortStageOverrides = {
		readSourceContext: options.stageOverrides?.readSourceContext ?? readSourceContext,
		fetchPortBotJson: options.stageOverrides?.fetchPortBotJson ?? fetchPortBotJson,
		resolvePluginConfig: options.stageOverrides?.resolvePluginConfig ?? resolvePluginConfig,
		decide: options.stageOverrides?.decide ?? decide,
		executePort: options.stageOverrides?.executePort ?? executePort,
		deliverResult: options.stageOverrides?.deliverResult ?? deliverResult,
		commentOnSourcePr: options.stageOverrides?.commentOnSourcePr ?? commentOnSourcePr,
	}

	try {
		const sourceChange: SourceChange = await stages.readSourceContext({
			octokit: options.octokit,
			owner: options.sourceRepo.owner,
			repo: options.sourceRepo.name,
			commitSha: options.commitSha,
		})

		logStage(logger, runId, 'context', {
			source: `${options.sourceRepo.owner}/${options.sourceRepo.name}`,
			pr: sourceChange.pullRequest?.number,
			files: sourceChange.files.length,
			contextMs: (stageTimings.contextMs = getDurationMs(startedAtMs)),
		})

		const resolvedPortBotJson =
			options.portBotJson === undefined && options.skipPortBotJson !== true
				? await stages.fetchPortBotJson({
						octokit: options.octokit,
						owner: options.sourceRepo.owner,
						repo: options.sourceRepo.name,
						ref: options.commitSha,
						logger,
					})
				: options.portBotJson

		const pluginConfig: PluginConfig = stages.resolvePluginConfig({
			builtInConfig: options.builtInConfig,
			portBotJson: resolvedPortBotJson,
		})

		logStage(logger, runId, 'config', {
			target: `${pluginConfig.targetRepo.owner}/${pluginConfig.targetRepo.name}`,
			configMs: (stageTimings.configMs = getDurationMs(startedAtMs)),
		})

		context = {
			runId,
			startedAt,
			sourceRepo: options.sourceRepo,
			sourceChange,
			pluginConfig,
		}

		decision = stages.decide(context)
		logStage(logger, runId, 'decision', {
			kind: decision.kind,
			decisionMs: (stageTimings.decisionMs = getDurationMs(startedAtMs)),
		})

		if (decision.kind === 'PORT_NOT_REQUIRED') {
			logOutcome(logger, runId, 'skipped_not_required', getDurationMs(startedAtMs))

			return {
				runId,
				outcome: 'skipped_not_required',
				decision,
				summary: renderRunSummary({ outcome: 'skipped_not_required', decision }),
				durationMs: getDurationMs(startedAtMs),
				stageTimings,
			}
		}

		if (decision.kind === 'NEEDS_HUMAN') {
			return runNeedsHumanFlow({
				octokit: options.octokit,
				context,
				decision,
				targetWorkingDirectory: options.targetWorkingDirectory,
				deliverStage: stages.deliverResult,
				commentStage: stages.commentOnSourcePr,
				logger,
				runId,
				startedAtMs,
				stageTimings,
			})
		}

		return runPortRequiredFlow({
			octokit: options.octokit,
			agentProvider: options.agentProvider,
			context,
			decision,
			targetWorkingDirectory: options.targetWorkingDirectory,
			sourceWorkingDirectory: options.sourceWorkingDirectory,
			diffFilePath: options.diffFilePath,
			maxAttempts: options.maxAttempts,
			executeStage: stages.executePort,
			deliverStage: stages.deliverResult,
			commentStage: stages.commentOnSourcePr,
			logger,
			runId,
			startedAtMs,
			stageTimings,
		})
	} catch (error) {
		const errorMessage = toErrorMessage(error)
		const failureDecision = decision ?? buildEngineFailureDecision(errorMessage)
		const sourcePullRequestNumber = context?.sourceChange.pullRequest?.number

		if (context && sourcePullRequestNumber) {
			try {
				await stages.commentOnSourcePr({
					octokit: options.octokit,
					sourceRepo: context.sourceRepo,
					pullRequestNumber: sourcePullRequestNumber,
					context,
					outcome: 'failed',
					runId,
					logger,
				})
			} catch (commentError) {
				logger.warn(
					'[port-bot] Unable to post source PR comment for failed run.',
					commentError,
				)
			}
		}

		logFailedOutcome(logger, runId, getDurationMs(startedAtMs), errorMessage)

		return {
			runId,
			outcome: 'failed',
			decision: failureDecision,
			summary: renderRunSummary({
				outcome: 'failed',
				decision: failureDecision,
				errorMessage,
			}),
			durationMs: getDurationMs(startedAtMs),
			stageTimings,
		}
	}
}
