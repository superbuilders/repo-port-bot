import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'

import { runAction } from './run-action.ts'

/**
 * Action entrypoint that runs the pipeline and publishes outputs.
 */
async function main(): Promise<void> {
	try {
		const result = await runAction()
		const artifactDirectory = join(process.cwd(), `port-bot-run-${result.runId}`)
		const toolCalls = result.execution?.history.flatMap(attempt => attempt.toolCallLog) ?? []
		const runResultPath = join(artifactDirectory, 'run-result.json')
		const toolCallsPath = join(artifactDirectory, 'tool-calls.json')
		const artifactClient = new DefaultArtifactClient()
		let artifactUploaded = false

		await mkdir(artifactDirectory, { recursive: true })
		await writeFile(runResultPath, JSON.stringify(result, null, 2))
		await writeFile(toolCallsPath, JSON.stringify(toolCalls, null, 2))

		if (process.env.ACTIONS_RUNTIME_TOKEN) {
			try {
				await artifactClient.uploadArtifact(
					`port-bot-run-${result.runId}`,
					[runResultPath, toolCallsPath],
					artifactDirectory,
					{ retentionDays: 14 },
				)
				artifactUploaded = true
			} catch (artifactError) {
				const message =
					artifactError instanceof Error ? artifactError.message : String(artifactError)

				core.warning(`Failed to upload observability artifact: ${message}`)
			}
		} else {
			core.info(
				'Skipping observability artifact upload because ACTIONS_RUNTIME_TOKEN is unavailable.',
			)
		}

		core.setOutput('run-id', result.runId)
		core.setOutput('outcome', result.outcome)
		core.setOutput('pr-url', result.targetPullRequestUrl ?? '')
		core.setOutput('issue-url', result.followUpIssueUrl ?? '')
		core.setOutput('summary', result.summary)

		const outcomeLine = buildOutcomeLine(result)

		core.summary.addRaw(`# ${result.summary}\n\n`)
		core.summary.addRaw(`${outcomeLine}\n\n`)
		core.summary.addTable([
			[
				{ data: 'Stage', header: true },
				{ data: 'Duration', header: true },
			],
			['context', formatMs(result.stageTimings?.contextMs)],
			['config', formatMs(result.stageTimings?.configMs)],
			['decision', formatMs(result.stageTimings?.decisionMs)],
			['execute', formatMs(result.stageTimings?.executeMs)],
			['deliver', formatMs(result.stageTimings?.deliverMs)],
			['notify', formatMs(result.stageTimings?.notifyMs)],
			['**total**', `**${formatMs(result.durationMs)}**`],
		])
		core.summary.addRaw(
			[
				'<details><summary>Decision & diagnostics</summary>\n',
				`- Kind: \`${result.decision.kind}\``,
				`- Reason: ${result.decision.reason}`,
				result.execution?.model ? `- Model: ${result.execution.model}` : undefined,
				artifactUploaded
					? `- Artifact: \`port-bot-run-${result.runId}\``
					: '- Artifact: skipped (runtime token unavailable)',
				`- Tool calls: ${String(toolCalls.length)}`,
				`- Run ID: \`${result.runId}\``,
				'\n</details>\n',
			]
				.filter(Boolean)
				.join('\n'),
		)
		await core.summary.write()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
}

void main()

/**
 * Build a human-readable one-liner describing the outcome with links.
 *
 * @param result - Pipeline result.
 * @returns Markdown one-liner.
 */
function buildOutcomeLine(result: Awaited<ReturnType<typeof runAction>>): string {
	switch (result.outcome) {
		case 'pr_opened': {
			const link = result.targetPullRequestUrl ?? 'target PR'

			return `Ported to ${link} — validation passed, ready for review.`
		}
		case 'draft_pr_opened': {
			const link = result.targetPullRequestUrl ?? 'target PR (draft)'

			return `Opened draft PR: ${link} — validation failed after ${String(result.execution?.attempts ?? '?')} attempts.`
		}
		case 'needs_human': {
			const link = result.followUpIssueUrl ?? 'follow-up issue'

			return `Opened ${link} for manual review.`
		}
		case 'skipped_not_required': {
			return `Skipped — ${result.decision.reason}`
		}
		case 'failed': {
			return `Failed: ${result.summary}`
		}
		default: {
			return result.summary
		}
	}
}

const MS_PER_SECOND = 1000

/**
 * Format milliseconds for display, returning 'N/A' when undefined.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string.
 */
function formatMs(ms: number | undefined): string {
	if (ms === undefined) {
		return 'N/A'
	}

	if (ms < MS_PER_SECOND) {
		return `${String(ms)}ms`
	}

	return `${(ms / MS_PER_SECOND).toFixed(1)}s`
}

export { runAction } from './run-action.ts'
