import { Octokit } from '@octokit/rest'
import { ClaudeAgentProvider } from '@repo-port-bot/agent-claude'
import { deliverResult, readSourceContext, runPort } from '@repo-port-bot/engine'

import { cloneSourceRepo } from './setup/clone-source-repo.ts'
import { cloneTargetRepo } from './setup/clone-target-repo.ts'
import { parseActionInputs } from './setup/parse-inputs.ts'

import type { RunActionDependencies } from './types.ts'

/**
 * Execute one full port-bot run for the current GitHub Actions context.
 *
 * @param dependencies - Injectable dependencies for tests.
 * @returns Port run result.
 */
export async function runAction(dependencies: Partial<RunActionDependencies> = {}) {
	const resolvedDependencies: RunActionDependencies = {
		parseInputs: dependencies.parseInputs ?? parseActionInputs,
		cloneSourceRepo: dependencies.cloneSourceRepo ?? cloneSourceRepo,
		cloneTargetRepo: dependencies.cloneTargetRepo ?? cloneTargetRepo,
		createOctokit: dependencies.createOctokit ?? (token => new Octokit({ auth: token })),
		createAgentProvider:
			dependencies.createAgentProvider ??
			(input =>
				new ClaudeAgentProvider({
					apiKey: input.apiKey,
					model: input.model,
					maxTurns: input.maxTurns,
					maxBudgetUsd: input.maxBudgetUsd,
				})),
		runPort: dependencies.runPort ?? runPort,
		readSourceContext: dependencies.readSourceContext ?? readSourceContext,
		deliverResult: dependencies.deliverResult ?? deliverResult,
	}
	const inputs = resolvedDependencies.parseInputs()
	const sourceOctokit = resolvedDependencies.createOctokit(inputs.effectiveSourceToken)
	const targetOctokit = resolvedDependencies.createOctokit(inputs.effectiveTargetToken)
	const agentProvider = resolvedDependencies.createAgentProvider({
		apiKey: inputs.llmApiKey,
		model: inputs.model,
		maxTurns: inputs.maxTurns,
		maxBudgetUsd: inputs.maxBudgetUsd,
	})
	const sourceClone = await resolvedDependencies.cloneSourceRepo({
		repo: inputs.sourceRepo,
		commitSha: inputs.commitSha,
		token: inputs.effectiveSourceToken,
	})
	const targetWorkingDirectory = await resolvedDependencies.cloneTargetRepo({
		repo: inputs.targetRepo,
		defaultBranch: inputs.targetDefaultBranch,
		token: inputs.effectiveTargetToken,
	})

	return resolvedDependencies.runPort({
		octokit: sourceOctokit,
		agentProvider,
		sourceRepo: inputs.sourceRepo,
		commitSha: inputs.commitSha,
		targetWorkingDirectory,
		sourceWorkingDirectory: sourceClone.sourceWorkingDirectory,
		diffFilePath: sourceClone.diffFilePath,
		maxAttempts: inputs.maxAttempts,
		skipPortBotJson: inputs.skipPortBotJson,
		builtInConfig: {
			targetRepo: {
				owner: inputs.targetRepo.owner,
				name: inputs.targetRepo.name,
				defaultBranch: inputs.targetDefaultBranch,
			},
			validationCommands: inputs.validationCommands,
			pathMappings: inputs.pathMappings,
			namingConventions: inputs.namingConventions,
			prompt: inputs.prompt,
		},
		stageOverrides: {
			readSourceContext: options =>
				resolvedDependencies.readSourceContext({
					...options,
					octokit: sourceOctokit,
				}),
			deliverResult: options =>
				resolvedDependencies.deliverResult({
					...options,
					octokit: targetOctokit,
				}),
		},
	})
}
