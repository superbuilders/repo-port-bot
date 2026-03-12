import { runValidationCommands } from '../execution/run-validation.ts'
import { checkTargetSideDiff, collectTouchedPaths } from '../github/ops.ts'
import { runCommand as defaultRunCommand } from '../github/ops.ts'
import { renderRunSummary } from '../github/render-body.ts'
import { getDurationMs } from '../utils.ts'
import { logOutcome, logStage } from './logging.ts'
import { runNeedsHumanFlow } from './needs-human.ts'
import { postSourcePrCommentBestEffort } from './notify-source.ts'
import { runPortRequiredFlow } from './port-required.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { executePort } from '../execution/execute-port.ts'
import type { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import type {
	AgentProvider,
	CommandRunner,
	DecidePortResult,
	DeterministicPhaseResult,
	GitHubWriter,
	PortDecisionKind,
	PortContext,
	PortRunResult,
} from '../types.ts'

interface SharedRouteInput {
	writer: GitHubWriter
	context: PortContext
	portDecision: DecidePortResult
	deliverStage: typeof deliverResult
	commentStage: typeof commentOnSourcePr
	logger: Logger
	runId: string
	sourceTitle?: string
	startedAtMs: number
	stageTimings: NonNullable<PortRunResult['stageTimings']>
	includeCostTelemetry: boolean
}

interface RouteDecisionOutcomeInput extends SharedRouteInput {
	agentProvider: AgentProvider
	targetWorkingDirectory: string
	sourceWorkingDirectory?: string
	diffFilePath?: string
	maxAttempts?: number
	executeStage: typeof executePort
	runCommand?: CommandRunner
}

interface RunDeterministicPrFlowInput extends SharedRouteInput {
	targetWorkingDirectory: string
	runCommand?: CommandRunner
}

/**
 * Route post-decision orchestration branches based on deterministic and residual state.
 *
 * @param input - Routing inputs.
 * @returns Terminal run result without telemetry aggregation.
 */
export async function routeDecisionOutcome(
	input: RouteDecisionOutcomeInput,
): Promise<PortRunResult> {
	const portDecisionKind = input.portDecision.outcome.kind
	const deterministicResult = getDeterministicResult(input.context)

	if (portDecisionKind === 'NO_AGENT_PORT_NEEDED' && !deterministicResult.changed) {
		return runSkippedNotRequiredFlow(input)
	}

	if (isNonExecutionDecision(portDecisionKind) && deterministicResult.changed) {
		return runDeterministicPrFlow({
			...input,
			targetWorkingDirectory: input.targetWorkingDirectory,
		})
	}

	if (portDecisionKind === 'NEEDS_HUMAN') {
		return runNeedsHumanFlow({
			...input,
			decision: input.portDecision,
			targetWorkingDirectory: input.targetWorkingDirectory,
		})
	}

	return runPortRequiredFlow({
		...input,
		decision: input.portDecision,
	})
}

/**
 * Return deterministic phase data, or the default "no deterministic changes" shape.
 *
 * @param context - Pipeline context.
 * @returns Deterministic phase result.
 */
function getDeterministicResult(context: PortContext): DeterministicPhaseResult {
	return (
		context.deterministic ?? {
			changed: false,
			operations: [],
			touchedFiles: [],
		}
	)
}

/**
 * Determine whether a decision kind uses non-execution routing.
 *
 * @param kind - Decision kind.
 * @returns True for NO_AGENT_PORT_NEEDED and NEEDS_HUMAN.
 */
function isNonExecutionDecision(kind: PortDecisionKind): boolean {
	return kind === 'NO_AGENT_PORT_NEEDED' || kind === 'NEEDS_HUMAN'
}

/**
 * Handle NO_AGENT_PORT_NEEDED runs where no deterministic target changes exist.
 *
 * @param input - Shared routing input.
 * @returns Skipped run result.
 */
async function runSkippedNotRequiredFlow(input: SharedRouteInput): Promise<PortRunResult> {
	const sourcePrNumber = input.context.sourceChange.pullRequest?.number

	if (sourcePrNumber) {
		try {
			await input.commentStage({
				writer: input.writer,
				pullRequestNumber: sourcePrNumber,
				context: input.context,
				decision: input.portDecision.outcome,
				decisionTrace: input.portDecision.trace,
				outcome: 'skipped_not_required',
				includeCostTelemetry: input.includeCostTelemetry,
				runId: input.runId,
				logger: input.logger,
			})
		} catch (commentError) {
			input.logger.warn(
				'[port-bot] Unable to post source PR comment for skipped run.',
				commentError,
			)
		}
	}

	logOutcome(input.logger, input.runId, 'skipped_not_required', getDurationMs(input.startedAtMs))

	return {
		runId: input.runId,
		sourceTitle: input.sourceTitle,
		outcome: 'skipped_not_required',
		decision: input.portDecision,
		summary: renderRunSummary({
			outcome: 'skipped_not_required',
			decision: input.portDecision,
		}),
		durationMs: getDurationMs(input.startedAtMs),
		stageTimings: input.stageTimings,
	}
}

/**
 * Deliver deterministic target-side changes as a PR for non-execution decisions.
 *
 * @param input - Flow input.
 * @returns PR-opened or draft-pr-opened run result.
 */
async function runDeterministicPrFlow(input: RunDeterministicPrFlowInput): Promise<PortRunResult> {
	const touchedPaths = collectTouchedPaths(
		input.context.deterministic,
		input.context.deterministic,
		undefined,
	)
	const runner = input.runCommand ?? defaultRunCommand
	const hasDiff = await checkTargetSideDiff(runner, input.targetWorkingDirectory, touchedPaths)

	if (!hasDiff) {
		if (input.portDecision.outcome.kind === 'NEEDS_HUMAN') {
			return runNeedsHumanFlow({
				...input,
				context: {
					...input.context,
					deterministic: { changed: false, operations: [], touchedFiles: [] },
				},
				decision: input.portDecision,
				targetWorkingDirectory: input.targetWorkingDirectory,
			})
		}

		const notifyMs = await postSourcePrCommentBestEffort({
			commentStage: input.commentStage,
			context: input.context,
			decision: input.portDecision.outcome,
			decisionTrace: input.portDecision.trace,
			writer: input.writer,
			outcome: 'skipped_not_required',
			includeCostTelemetry: input.includeCostTelemetry,
			runId: input.runId,
			logger: input.logger,
		})

		if (notifyMs !== undefined) {
			logStage(input.logger, input.runId, 'notify', {
				outcome: 'skipped_not_required',
				notifyMs: (input.stageTimings.notifyMs = notifyMs),
			})
		}

		logOutcome(
			input.logger,
			input.runId,
			'skipped_not_required',
			getDurationMs(input.startedAtMs),
		)

		return {
			runId: input.runId,
			sourceTitle: input.sourceTitle,
			outcome: 'skipped_not_required',
			decision: input.portDecision,
			summary: renderRunSummary({
				outcome: 'skipped_not_required',
				decision: input.portDecision,
			}),
			durationMs: getDurationMs(input.startedAtMs),
			stageTimings: input.stageTimings,
		}
	}

	const validation = await runValidationCommands({
		commands: input.context.pluginConfig.validationCommands,
		workingDirectory: input.targetWorkingDirectory,
	})
	const framingMode =
		input.portDecision.outcome.kind === 'NEEDS_HUMAN'
			? 'residual_handoff'
			: 'deterministic_only'
	const deliverStartedAtMs = Date.now()

	const delivery = await input.deliverStage({
		writer: input.writer,
		context: input.context,
		deterministic: input.context.deterministic,
		decision: input.portDecision.outcome,
		decisionTrace: input.portDecision.trace,
		validation,
		framingMode,
		targetWorkingDirectory: input.targetWorkingDirectory,
		includeCostTelemetry: input.includeCostTelemetry,
		logger: input.logger,
	})

	logStage(input.logger, input.runId, 'deliver', {
		outcome: delivery.outcome,
		deliverMs: (input.stageTimings.deliverMs = getDurationMs(deliverStartedAtMs)),
	})

	const outcome = delivery.outcome === 'draft_pr_opened' ? 'draft_pr_opened' : 'pr_opened'
	const notifyMs = await postSourcePrCommentBestEffort({
		commentStage: input.commentStage,
		context: input.context,
		decision: input.portDecision.outcome,
		decisionTrace: input.portDecision.trace,
		writer: input.writer,
		outcome,
		targetPullRequestUrl: delivery.targetPullRequestUrl,
		includeCostTelemetry: input.includeCostTelemetry,
		runId: input.runId,
		logger: input.logger,
	})

	if (notifyMs !== undefined) {
		logStage(input.logger, input.runId, 'notify', {
			outcome,
			notifyMs: (input.stageTimings.notifyMs = notifyMs),
		})
	}

	logOutcome(input.logger, input.runId, outcome, getDurationMs(input.startedAtMs))

	return {
		runId: input.runId,
		sourceTitle: input.sourceTitle,
		outcome,
		decision: input.portDecision,
		targetPullRequestUrl: delivery.targetPullRequestUrl,
		summary: renderRunSummary({
			outcome,
			decision: input.portDecision,
			targetPullRequestUrl: delivery.targetPullRequestUrl,
		}),
		durationMs: getDurationMs(input.startedAtMs),
		stageTimings: input.stageTimings,
	}
}
