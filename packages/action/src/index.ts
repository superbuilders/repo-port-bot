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

		await mkdir(artifactDirectory, { recursive: true })
		await writeFile(runResultPath, JSON.stringify(result, null, 2))
		await writeFile(toolCallsPath, JSON.stringify(toolCalls, null, 2))

		try {
			await artifactClient.uploadArtifact(
				`port-bot-run-${result.runId}`,
				[runResultPath, toolCallsPath],
				artifactDirectory,
				{ retentionDays: 14 },
			)
		} catch (artifactError) {
			const message =
				artifactError instanceof Error ? artifactError.message : String(artifactError)

			core.warning(`Failed to upload observability artifact: ${message}`)
		}

		core.setOutput('run-id', result.runId)
		core.setOutput('outcome', result.outcome)
		core.setOutput('pr-url', result.targetPullRequestUrl ?? '')
		core.setOutput('issue-url', result.followUpIssueUrl ?? '')
		core.setOutput('summary', result.summary)
		core.summary.addHeading('repo-port-bot result')
		core.summary.addTable([
			[
				{ data: 'Field', header: true },
				{ data: 'Value', header: true },
			],
			['Run ID', result.runId],
			['Outcome', result.outcome],
			['Duration (ms)', String(result.durationMs)],
			[
				'Source PR',
				result.decision.kind === 'PORT_NOT_REQUIRED' ? 'Skipped' : 'See source PR comment',
			],
			['Target PR', result.targetPullRequestUrl ?? 'N/A'],
			['Follow-up issue', result.followUpIssueUrl ?? 'N/A'],
		])
		core.summary.addHeading('Decision', 2)
		core.summary.addRaw(`- Kind: \`${result.decision.kind}\`\n`)
		core.summary.addRaw(`- Reason: ${result.decision.reason}\n`)

		if (result.execution) {
			core.summary.addHeading('Execution', 2)
			core.summary.addRaw(`- Attempts: ${String(result.execution.attempts)}\n`)
			core.summary.addRaw(`- Success: ${result.execution.success ? 'yes' : 'no'}\n`)
			core.summary.addRaw(
				`- Touched files: ${String(result.execution.touchedFiles.length)}\n`,
			)
		}

		core.summary.addHeading('Stage timings', 2)
		core.summary.addTable([
			[
				{ data: 'Stage', header: true },
				{ data: 'Duration (ms)', header: true },
			],
			[
				'context',
				result.stageTimings?.contextMs ? String(result.stageTimings.contextMs) : 'N/A',
			],
			[
				'config',
				result.stageTimings?.configMs ? String(result.stageTimings.configMs) : 'N/A',
			],
			[
				'decision',
				result.stageTimings?.decisionMs ? String(result.stageTimings.decisionMs) : 'N/A',
			],
			[
				'execute',
				result.stageTimings?.executeMs ? String(result.stageTimings.executeMs) : 'N/A',
			],
			[
				'deliver',
				result.stageTimings?.deliverMs ? String(result.stageTimings.deliverMs) : 'N/A',
			],
			[
				'notify',
				result.stageTimings?.notifyMs ? String(result.stageTimings.notifyMs) : 'N/A',
			],
		])
		core.summary.addHeading('Artifact', 2)
		core.summary.addRaw(`- Uploaded: \`port-bot-run-${result.runId}\`\n`)
		core.summary.addRaw(`- Tool calls: ${String(toolCalls.length)}\n`)
		await core.summary.write()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
}

void main()

export { runAction } from './run-action.ts'
