import { readFile, writeFile } from 'node:fs/promises'

import { createConsoleLogger } from '@repo-port-bot/logger'

import { fetchPortBotJson } from '../config/fetch-port-bot-json.ts'
import { resolvePluginConfig } from '../config/resolve-plugin-config.ts'
import {
	buildEngineFailureDecision,
	decide,
	decidePreDeterministicSkip,
} from '../decision/decide.ts'
import { executeDeterministic } from '../execution/execute-deterministic.ts'
import { executePort } from '../execution/execute-port.ts'
import { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import { readSourceContext } from '../github/read-source-context.ts'
import { renderRunSummary } from '../github/render-body.ts'
import {
	sumAggregatedTelemetry,
	sumStageTelemetry,
	toAggregatedTelemetry,
} from '../lib/telemetry.ts'
import { getDurationMs, logAgentMessage, toErrorMessage } from '../utils.ts'
import { filterDiffContent, filterIgnoredFiles } from './filter-ignored.ts'
import { logFailedOutcome, logStage } from './logging.ts'
import { routeDecisionOutcome } from './route-decision-outcome.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { PortBotJsonConfig } from '../config/types.ts'
import type {
	AgentProvider,
	CommandRunner,
	DeterministicPhaseResult,
	FilteringMetadata,
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
	executeDeterministic: typeof executeDeterministic
	decide: typeof decide
	executePort: typeof executePort
	deliverResult: typeof deliverResult
	commentOnSourcePr: typeof commentOnSourcePr
	runCommand?: CommandRunner
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
	includeCostTelemetry?: boolean
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
		executeDeterministic: options.stageOverrides?.executeDeterministic ?? executeDeterministic,
		decide: options.stageOverrides?.decide ?? decide,
		executePort: options.stageOverrides?.executePort ?? executePort,
		deliverResult: options.stageOverrides?.deliverResult ?? deliverResult,
		commentOnSourcePr: options.stageOverrides?.commentOnSourcePr ?? commentOnSourcePr,
		runCommand: options.stageOverrides?.runCommand,
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

		const originalFileCount = sourceChange.files.length
		const filteredSourceChange: SourceChange = {
			...sourceChange,
			files: filterIgnoredFiles(sourceChange.files, pluginConfig.ignorePatterns),
		}
		const removedFileCount = originalFileCount - filteredSourceChange.files.length
		const filtering: FilteringMetadata | undefined =
			removedFileCount > 0
				? {
						originalFileCount,
						removedFileCount,
					}
				: undefined

		if (options.diffFilePath && pluginConfig.ignorePatterns.length > 0) {
			const currentDiff = await readFile(options.diffFilePath, 'utf8')
			const filteredDiff = filterDiffContent(currentDiff, pluginConfig.ignorePatterns)

			if (filteredDiff !== currentDiff) {
				await writeFile(options.diffFilePath, filteredDiff, 'utf8')
			}
		}

		context = {
			runId,
			startedAt,
			sourceRepo: options.sourceRepo,
			sourceChange: filteredSourceChange,
			pluginConfig,
			filtering,
			deterministic: {
				changed: false,
				operations: [],
				touchedFiles: [],
			},
		}

		const preDeterministicSkipDecision = decidePreDeterministicSkip(context)

		if (preDeterministicSkipDecision) {
			decision = preDeterministicSkipDecision
			logStage(logger, runId, 'decision', {
				kind: decision.outcome.kind,
				reason: decision.outcome.reason,
				decisionMs: (stageTimings.decisionMs = getDurationMs(startedAtMs)),
			})

			return withTelemetry(
				await routeDecisionOutcome({
					writer: options.writer,
					agentProvider: options.agentProvider,
					context,
					portDecision: decision,
					targetWorkingDirectory: options.targetWorkingDirectory,
					sourceWorkingDirectory: options.sourceWorkingDirectory,
					diffFilePath: options.diffFilePath,
					maxAttempts: options.maxAttempts,
					executeStage: stages.executePort,
					deliverStage: stages.deliverResult,
					commentStage: stages.commentOnSourcePr,
					runCommand: stages.runCommand,
					logger,
					runId,
					sourceTitle,
					startedAtMs,
					stageTimings,
					includeCostTelemetry: options.includeCostTelemetry ?? true,
				}),
			)
		}

		const deterministicStartedAtMs = Date.now()

		const deterministicResult = await buildDeterministicResult(
			pluginConfig,
			options,
			stages,
			logger,
		)

		context = {
			...context,
			deterministic: deterministicResult,
		}

		logStage(logger, runId, 'deterministic', {
			operations: deterministicResult.operations.length,
			changed: String(deterministicResult.changed),
			deterministicMs: (stageTimings.deterministicMs =
				getDurationMs(deterministicStartedAtMs)),
		})

		logger.group('Decision: classify source change')

		try {
			const decisionResult = await stages.decide(context, {
				agentProvider: options.agentProvider,
				targetWorkingDirectory: options.targetWorkingDirectory,
				sourceWorkingDirectory: options.sourceWorkingDirectory,
				diffFilePath: options.diffFilePath,
				onMessage: message => {
					logAgentMessage({
						logger,
						runId,
						stage: 'decision',
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

		return withTelemetry(
			await routeDecisionOutcome({
				writer: options.writer,
				agentProvider: options.agentProvider,
				context,
				portDecision: decision,
				targetWorkingDirectory: options.targetWorkingDirectory,
				sourceWorkingDirectory: options.sourceWorkingDirectory,
				diffFilePath: options.diffFilePath,
				maxAttempts: options.maxAttempts,
				executeStage: stages.executePort,
				deliverStage: stages.deliverResult,
				commentStage: stages.commentOnSourcePr,
				runCommand: stages.runCommand,
				logger,
				runId,
				sourceTitle,
				startedAtMs,
				stageTimings,
				includeCostTelemetry: options.includeCostTelemetry ?? true,
			}),
		)
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
					decisionTrace: failureDecisionValue.trace,
					outcome: 'failed',
					includeCostTelemetry: options.includeCostTelemetry ?? true,
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
			telemetry: buildRunTelemetry(failureDecisionValue),
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
 * Build deterministic phase result, warning when sync is configured but source checkout is missing.
 *
 * @param pluginConfig - Resolved plugin config.
 * @param options - Pipeline options.
 * @param stages - Stage overrides.
 * @param logger - Logger.
 * @returns Deterministic phase result.
 */
async function buildDeterministicResult(
	pluginConfig: PluginConfig,
	options: RunPortOptions,
	stages: RunPortStageOverrides,
	logger: Logger,
): Promise<DeterministicPhaseResult> {
	if (pluginConfig.deterministicOperations.length === 0) {
		return { changed: false, operations: [], touchedFiles: [] }
	}

	if (!options.sourceWorkingDirectory) {
		logger.warn(
			'[port-bot] Deterministic operations are configured but sourceWorkingDirectory is not available. Sync operations will be skipped.',
		)

		return { changed: false, operations: [], touchedFiles: [] }
	}

	return stages.executeDeterministic({
		deterministicOperations: pluginConfig.deterministicOperations,
		sourceWorkingDirectory: options.sourceWorkingDirectory,
		targetWorkingDirectory: options.targetWorkingDirectory,
	})
}

/**
 * Attach computed telemetry aggregates onto the terminal run result.
 *
 * @param result - Terminal run result.
 * @returns Result with telemetry field populated.
 */
function withTelemetry(result: PortRunResult): PortRunResult {
	return {
		...result,
		telemetry: buildRunTelemetry(result.decision, result.execution),
	}
}

/**
 * Build run-level telemetry aggregates from decision and execution traces.
 *
 * @param decision - Decision stage result.
 * @param execution - Optional execution stage result.
 * @returns Run telemetry payload.
 */
function buildRunTelemetry(
	decision: PortRunResult['decision'],
	execution?: PortRunResult['execution'],
): PortRunResult['telemetry'] {
	const decisionTotals = toAggregatedTelemetry(decision.trace.costUsd, decision.trace.usage)
	const executionTotals = execution
		? sumStageTelemetry(execution.trace.attempts.map(attempt => attempt.trace))
		: undefined
	const total = sumAggregatedTelemetry(decisionTotals, executionTotals)

	if (!decisionTotals && !executionTotals && !total) {
		return undefined
	}

	return {
		decision: decisionTotals,
		execution: executionTotals,
		total,
	}
}
