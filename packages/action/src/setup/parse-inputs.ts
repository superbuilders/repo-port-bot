import * as core from '@actions/core'
import * as github from '@actions/github'

import type { ParseActionInputsDependencies, ParsedActionInputs, ParsedRepo } from '../types.ts'

const REPO_SEGMENT_COUNT = 2

/**
 * Parse integer action input with lower-bound validation.
 *
 * @param name - Input name.
 * @param value - Raw input value.
 * @param minimum - Inclusive minimum.
 * @returns Parsed integer.
 */
function parseInteger(name: string, value: string, minimum = 1): number {
	const parsed = Number.parseInt(value, 10)

	if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < minimum) {
		throw new Error(`Input "${name}" must be an integer >= ${String(minimum)}.`)
	}

	return parsed
}

/**
 * Parse optional numeric action input.
 *
 * @param name - Input name.
 * @param value - Raw input value.
 * @returns Parsed number or undefined.
 */
function parseOptionalNumber(name: string, value: string): number | undefined {
	const trimmed = value.trim()

	if (trimmed.length === 0) {
		return undefined
	}

	const parsed = Number(trimmed)

	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Input "${name}" must be a positive number when provided.`)
	}

	return parsed
}

/**
 * Parse owner/name repo input.
 *
 * @param rawRepo - Raw repo string.
 * @returns Parsed owner/name pair.
 */
function parseRepo(rawRepo: string): ParsedRepo {
	const trimmed = rawRepo.trim()
	const segments = trimmed.split('/').map(segment => segment.trim())

	if (segments.length !== REPO_SEGMENT_COUNT || segments.some(segment => segment.length === 0)) {
		throw new Error('Input "target-repo" must be in "owner/name" format.')
	}

	return {
		owner: segments[0]!,
		name: segments[1]!,
	}
}

/**
 * Parse path mappings input as a flat object map.
 *
 * @param rawValue - JSON input value.
 * @returns Parsed map.
 */
function parsePathMappings(rawValue: string): Record<string, string> {
	let parsedJson: unknown = {}
	const trimmed = rawValue.trim()

	if (trimmed.length > 0) {
		try {
			parsedJson = JSON.parse(trimmed)
		} catch {
			throw new Error('Input "path-mappings" must be a valid JSON object.')
		}
	}

	if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
		throw new Error('Input "path-mappings" must be a JSON object.')
	}

	const mappings: Record<string, string> = {}

	for (const [sourcePath, targetPath] of Object.entries(parsedJson)) {
		if (typeof targetPath !== 'string') {
			throw new Error('Input "path-mappings" must map string keys to string values only.')
		}

		mappings[sourcePath] = targetPath
	}

	return mappings
}

/**
 * Parse newline-separated commands.
 *
 * @param rawValue - Input value.
 * @returns Command list.
 */
function parseValidationCommands(rawValue: string): string[] {
	return rawValue
		.split('\n')
		.map(command => command.trim())
		.filter(command => command.length > 0)
}

/**
 * Parse and validate all action inputs + workflow context.
 *
 * @param dependencies - Injectable input/context dependencies for testing.
 * @returns Parsed input contract for orchestration.
 */
export function parseActionInputs(
	dependencies: Partial<ParseActionInputsDependencies> = {},
): ParsedActionInputs {
	const getInput = dependencies.getInput ?? core.getInput
	const context = dependencies.context ?? github.context
	const githubToken = getInput('github-token').trim()
	const sourceGithubToken = getInput('source-github-token').trim()
	const targetGithubToken = getInput('target-github-token').trim()
	const effectiveSourceToken = sourceGithubToken || githubToken
	const effectiveTargetToken = targetGithubToken || githubToken

	if (!effectiveSourceToken) {
		throw new Error(
			'Missing source GitHub token. Provide "source-github-token" or fallback "github-token".',
		)
	}

	if (!effectiveTargetToken) {
		throw new Error(
			'Missing target GitHub token. Provide "target-github-token" or fallback "github-token".',
		)
	}

	const sourceOwner = context.repo.owner
	const sourceName = context.repo.repo
	const defaultBranch = (context.payload.repository?.default_branch ?? '').trim() || 'main'
	const commitSha = context.sha.trim()

	if (!sourceOwner || !sourceName || !commitSha) {
		throw new Error('Unable to resolve source repository or commit SHA from workflow context.')
	}

	const llmApiKey = getInput('llm-api-key', { required: true }).trim()
	const targetRepo = parseRepo(getInput('target-repo', { required: true }))
	const targetDefaultBranch = getInput('target-default-branch').trim() || 'main'
	const model = getInput('model').trim() || 'claude-sonnet-4-6'
	const maxAttempts = parseInteger('max-attempts', getInput('max-attempts'))
	const maxTurns = parseInteger('max-turns', getInput('max-turns'))
	const maxBudgetUsd = parseOptionalNumber('max-budget-usd', getInput('max-budget-usd'))
	const validationCommands = parseValidationCommands(getInput('validation-commands'))
	const pathMappings = parsePathMappings(getInput('path-mappings'))
	const namingConventions = getInput('naming-conventions').trim() || undefined
	const prompt = getInput('prompt').trim() || undefined

	return {
		sourceRepo: {
			owner: sourceOwner,
			name: sourceName,
			defaultBranch,
		},
		commitSha,
		targetRepo,
		targetDefaultBranch,
		llmApiKey,
		model,
		maxAttempts,
		maxTurns,
		maxBudgetUsd,
		validationCommands,
		pathMappings,
		namingConventions,
		prompt,
		effectiveSourceToken,
		effectiveTargetToken,
	}
}
