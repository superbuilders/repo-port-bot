import { createConsoleLogger, formatPortBotLine } from '@repo-port-bot/logger'

import { fetchPortBotJson } from '../config/fetch-port-bot-json.ts'
import { resolvePluginConfig } from '../config/resolve-plugin-config.ts'
import { buildEngineFailureDecision, decide } from '../decision/decide.ts'
import { executePort } from '../execution/execute-port.ts'
import { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import { readSourceContext } from '../github/read-source-context.ts'
import { renderRunSummary } from '../github/render-body.ts'
import {
	extractFilePath,
	getDurationMs,
	normalizeLoggedFilePath,
	toErrorMessage,
} from '../utils.ts'
import { logFailedOutcome, logOutcome, logStage } from './logging.ts'
import { runNeedsHumanFlow } from './needs-human.ts'
import { runPortRequiredFlow } from './port-required.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { PortBotJsonConfig } from '../config/types.ts'
import type {
	AgentProvider,
	AgentMessage,
	GitHubReader,
	GitHubWriter,
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
	reader: GitHubReader
	writer: GitHubWriter
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

	let sourceTitle: string | undefined = undefined

	try {
		const sourceChange: SourceChange = await (async () => {
			logger.group(
				`Context: ${options.sourceRepo.owner}/${options.sourceRepo.name} ${options.commitSha}`,
			)

			try {
				const stageSourceChange = await stages.readSourceContext({
					reader: options.reader,
					owner: options.sourceRepo.owner,
					repo: options.sourceRepo.name,
					commitSha: options.commitSha,
				})

				logStage(logger, runId, 'context', {
					source: `${options.sourceRepo.owner}/${options.sourceRepo.name}`,
					pr: stageSourceChange.pullRequest?.number,
					files: stageSourceChange.files.length,
					contextMs: (stageTimings.contextMs = getDurationMs(startedAtMs)),
				})

				return stageSourceChange
			} finally {
				logger.groupEnd()
			}
		})()

		sourceTitle = sourceChange.pullRequest?.title

		const pluginConfig: PluginConfig = await (async () => {
			logger.group('Config: resolve plugin config')

			try {
				const resolvedPortBotJson =
					options.portBotJson === undefined && options.skipPortBotJson !== true
						? await stages.fetchPortBotJson({
								reader: options.reader,
								owner: options.sourceRepo.owner,
								repo: options.sourceRepo.name,
								ref: options.commitSha,
								logger,
							})
						: options.portBotJson

				const stagePluginConfig = stages.resolvePluginConfig({
					builtInConfig: options.builtInConfig,
					portBotJson: resolvedPortBotJson,
				})

				logStage(logger, runId, 'config', {
					target: `${stagePluginConfig.targetRepo.owner}/${stagePluginConfig.targetRepo.name}`,
					configMs: (stageTimings.configMs = getDurationMs(startedAtMs)),
				})

				return stagePluginConfig
			} finally {
				logger.groupEnd()
			}
		})()

		context = {
			runId,
			startedAt,
			sourceRepo: options.sourceRepo,
			sourceChange,
			pluginConfig,
		}

		logger.group('Decision: classify source change')

		try {
			const decisionResult = await stages.decide(context, {
				agentProvider: options.agentProvider,
				targetWorkingDirectory: options.targetWorkingDirectory,
				sourceWorkingDirectory: options.sourceWorkingDirectory,
				diffFilePath: options.diffFilePath,
				onMessage: message => {
					logDecisionMessage({
						logger,
						runId,
						message,
						targetWorkingDirectory: options.targetWorkingDirectory,
						sourceWorkingDirectory: options.sourceWorkingDirectory,
					})
				},
			})

			decision = decisionResult
			logStage(logger, runId, 'decision', {
				kind: decision.outcome.kind,
				reason: decision.outcome.reason,
				decisionMs: (stageTimings.decisionMs = getDurationMs(startedAtMs)),
			})
		} finally {
			logger.groupEnd()
		}

		if (decision.outcome.kind === 'PORT_NOT_REQUIRED') {
			const sourcePrNumber = context.sourceChange.pullRequest?.number

			if (sourcePrNumber) {
				try {
					await stages.commentOnSourcePr({
						writer: options.writer,
						pullRequestNumber: sourcePrNumber,
						context,
						decision: decision.outcome,
						outcome: 'skipped_not_required',
						runId,
						logger,
					})
				} catch (commentError) {
					logger.warn(
						'[port-bot] Unable to post source PR comment for skipped run.',
						commentError,
					)
				}
			}

			logOutcome(logger, runId, 'skipped_not_required', getDurationMs(startedAtMs))

			return {
				runId,
				sourceTitle,
				outcome: 'skipped_not_required',
				decision,
				summary: renderRunSummary({ outcome: 'skipped_not_required', decision }),
				durationMs: getDurationMs(startedAtMs),
				stageTimings,
			}
		}

		if (decision.outcome.kind === 'NEEDS_HUMAN') {
			return runNeedsHumanFlow({
				writer: options.writer,
				context,
				decision,
				targetWorkingDirectory: options.targetWorkingDirectory,
				deliverStage: stages.deliverResult,
				commentStage: stages.commentOnSourcePr,
				logger,
				runId,
				sourceTitle,
				startedAtMs,
				stageTimings,
			})
		}

		return runPortRequiredFlow({
			writer: options.writer,
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
			sourceTitle,
			startedAtMs,
			stageTimings,
		})
	} catch (error) {
		const errorMessage = toErrorMessage(error)
		const failureDecision = buildEngineFailureDecision(errorMessage)
		const failureDecisionValue = decision ?? failureDecision
		const sourcePullRequestNumber = context?.sourceChange.pullRequest?.number

		if (context && sourcePullRequestNumber) {
			try {
				await stages.commentOnSourcePr({
					writer: options.writer,
					pullRequestNumber: sourcePullRequestNumber,
					context,
					decision: failureDecisionValue.outcome,
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
			sourceTitle,
			outcome: 'failed',
			decision: failureDecisionValue,
			summary: renderRunSummary({
				outcome: 'failed',
				decision: failureDecisionValue,
				errorMessage,
			}),
			durationMs: getDurationMs(startedAtMs),
			stageTimings,
		}
	}
}

/**
 * Log one streamed decision-stage agent message using structured formatting.
 *
 * @param input - Message logging input.
 * @param input.logger - Logger implementation.
 * @param input.runId - Run identifier for correlation.
 * @param input.message - Streamed agent message.
 * @param input.targetWorkingDirectory - Optional target repo root for path normalization.
 * @param input.sourceWorkingDirectory - Optional source repo root for path normalization.
 */
function logDecisionMessage(input: {
	logger: Logger
	runId: string
	message: AgentMessage
	targetWorkingDirectory?: string
	sourceWorkingDirectory?: string
}): void {
	const { logger, runId, message } = input

	if (message.kind === 'tool_start') {
		const filePath = extractFilePath(message.toolInput)
		const loggedFilePath = normalizeLoggedFilePath({
			filePath,
			targetWorkingDirectory: input.targetWorkingDirectory,
			sourceWorkingDirectory: input.sourceWorkingDirectory,
		})

		logger.info(
			formatPortBotLine({
				runId,
				fields: {
					stage: 'decision',
					tool: message.toolName,
					file: loggedFilePath,
				},
			}),
		)

		return
	}

	if (message.kind === 'tool_end') {
		logger.debug(
			formatPortBotLine({
				runId,
				fields: {
					stage: 'decision',
					tool: message.toolName,
					toolDurationMs: message.durationMs,
				},
			}),
		)

		return
	}

	logger.debug(
		formatPortBotLine({
			runId,
			fields: {
				stage: 'decision',
				[message.kind]: message.text,
			},
		}),
	)
}
