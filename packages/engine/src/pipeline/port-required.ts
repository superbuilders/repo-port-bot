import { renderRunSummary } from '../github/render-body.ts'
import { getDurationMs } from '../utils.ts'
import { logOutcome, logStage } from './logging.ts'
import { postSourcePrCommentBestEffort } from './notify-source.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { executePort } from '../execution/execute-port.ts'
import type { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import type {
	AgentProvider,
	CommandRunner,
	DecidePortResult,
	GitHubWriter,
	PortContext,
	PortRunResult,
} from '../types.ts'

interface PortRequiredFlowInput {
	writer: GitHubWriter
	agentProvider: AgentProvider
	context: PortContext
	decision: DecidePortResult
	targetWorkingDirectory: string
	sourceWorkingDirectory?: string
	diffFilePath?: string
	maxAttempts?: number
	executeStage: typeof executePort
	deliverStage: typeof deliverResult
	commentStage: typeof commentOnSourcePr
	runCommand?: CommandRunner
	logger: Logger
	runId: string
	sourceTitle?: string
	startedAtMs: number
	stageTimings: NonNullable<PortRunResult['stageTimings']>
	includeCostTelemetry: boolean
}

/**
 * Execute the PORT_REQUIRED branch: run agent, deliver PR, notify source PR, return result.
 *
 * @param input - Flow input.
 * @returns Port-required run result.
 */
export async function runPortRequiredFlow(input: PortRequiredFlowInput): Promise<PortRunResult> {
	const executeStartedAtMs = Date.now()
	const execution = await input.executeStage({
		agentProvider: input.agentProvider,
		context: input.context,
		maxAttempts: input.maxAttempts,
		targetWorkingDirectory: input.targetWorkingDirectory,
		sourceWorkingDirectory: input.sourceWorkingDirectory,
		diffFilePath: input.diffFilePath,
		logger: input.logger,
	})

	logStage(input.logger, input.runId, 'execute', {
		attempts: execution.outcome.attempts,
		success: execution.outcome.status === 'SUCCEEDED' ? 'pass' : 'fail',
		executeMs: (input.stageTimings.executeMs = getDurationMs(executeStartedAtMs)),
	})

	const delivery: Awaited<ReturnType<typeof input.deliverStage>> = await (async () => {
		input.logger.group('Deliver: PORT_REQUIRED')

		try {
			const deliverStartedAtMs = Date.now()
			const stageDelivery = await input.deliverStage({
				writer: input.writer,
				context: input.context,
				decision: input.decision.outcome,
				decisionTrace: input.decision.trace,
				execution,
				deterministic: input.context.deterministic,
				framingMode:
					execution.outcome.status === 'SUCCEEDED' ? 'agent_success' : 'agent_stalled',
				targetWorkingDirectory: input.targetWorkingDirectory,
				includeCostTelemetry: input.includeCostTelemetry,
				runCommand: input.runCommand,
				logger: input.logger,
			})

			logStage(input.logger, input.runId, 'deliver', {
				outcome: stageDelivery.outcome,
				deliverMs: (input.stageTimings.deliverMs = getDurationMs(deliverStartedAtMs)),
			})

			return stageDelivery
		} finally {
			input.logger.groupEnd()
		}
	})()

	if (delivery.outcome === 'skipped') {
		const errorMessage = 'PORT_REQUIRED execution produced no deliverable changes.'
		const notifyMs = await postSourcePrCommentBestEffort({
			commentStage: input.commentStage,
			context: input.context,
			decision: input.decision.outcome,
			decisionTrace: input.decision.trace,
			writer: input.writer,
			outcome: 'failed',
			includeCostTelemetry: input.includeCostTelemetry,
			runId: input.runId,
			logger: input.logger,
		})

		if (notifyMs !== undefined) {
			logStage(input.logger, input.runId, 'notify', {
				outcome: 'failed',
				notifyMs: (input.stageTimings.notifyMs = notifyMs),
			})
		}

		logOutcome(input.logger, input.runId, 'failed', getDurationMs(input.startedAtMs))

		return {
			runId: input.runId,
			sourceTitle: input.sourceTitle,
			outcome: 'failed',
			decision: input.decision,
			execution,
			summary: renderRunSummary({
				outcome: 'failed',
				decision: input.decision,
				errorMessage,
			}),
			durationMs: getDurationMs(input.startedAtMs),
			stageTimings: input.stageTimings,
		}
	}

	if (delivery.outcome !== 'pr_opened' && delivery.outcome !== 'draft_pr_opened') {
		throw new Error(
			`Unexpected delivery outcome for PORT_REQUIRED decision: ${delivery.outcome}`,
		)
	}

	const outcome = delivery.outcome

	await (async () => {
		input.logger.group('Notify: source PR comment')

		try {
			const ms = await postSourcePrCommentBestEffort({
				commentStage: input.commentStage,
				context: input.context,
				decision: input.decision.outcome,
				decisionTrace: input.decision.trace,
				writer: input.writer,
				outcome,
				targetPullRequestUrl: delivery.targetPullRequestUrl,
				execution,
				includeCostTelemetry: input.includeCostTelemetry,
				runId: input.runId,
				logger: input.logger,
			})

			if (ms !== undefined) {
				logStage(input.logger, input.runId, 'notify', {
					outcome,
					notifyMs: (input.stageTimings.notifyMs = ms),
				})
			}
		} finally {
			input.logger.groupEnd()
		}
	})()

	logOutcome(input.logger, input.runId, outcome, getDurationMs(input.startedAtMs))

	return {
		runId: input.runId,
		sourceTitle: input.sourceTitle,
		outcome,
		decision: input.decision,
		execution,
		targetPullRequestUrl: delivery.targetPullRequestUrl,
		summary: renderRunSummary({
			outcome,
			decision: input.decision,
			execution,
			targetPullRequestUrl: delivery.targetPullRequestUrl,
		}),
		durationMs: getDurationMs(input.startedAtMs),
		stageTimings: input.stageTimings,
	}
}
