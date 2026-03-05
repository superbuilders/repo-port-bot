#!/usr/bin/env bun

/**
 * Generate release PR title and body from the commit range between
 * origin/main and the current branch (or a custom range).
 *
 * Usage:
 *   bun scripts/release-notes.ts              # defaults to origin/main..HEAD
 *   bun scripts/release-notes.ts dev          # origin/main..dev
 *   bun scripts/release-notes.ts abc123..def456
 *
 * Output (JSON):
 *   { "title": "release: ...", "body": "## Features\n..." }
 */

import { execSync } from 'node:child_process'

interface Commit {
	type: string
	scope: string
	description: string
}

const TYPE_LABELS: Record<string, string> = {
	feat: 'Features',
	fix: 'Fixes',
}

const MAX_TITLE_LENGTH = 72

/**
 * Resolve a git range from the CLI argument.
 *
 * @param arg - Optional branch name or explicit range.
 * @returns Git log range string.
 */
function parseRange(arg?: string): string {
	if (!arg) {
		return 'origin/main..HEAD'
	}

	if (arg.includes('..')) {
		return arg
	}

	return `origin/main..${arg}`
}

/**
 * Read one-line commit messages from the given git range.
 *
 * @param range - Git range string.
 * @returns Array of one-line commit strings.
 */
function getCommitLines(range: string): string[] {
	const output = execSync(`git log --oneline --no-decorate ${range}`, {
		encoding: 'utf8',
	}).trim()

	if (!output) {
		return []
	}

	return output.split('\n')
}

/**
 * Parse a conventional commit one-liner into structured parts.
 * Supports both `type(scope): desc` and `type: desc` (no scope).
 *
 * @param line - One-line git log entry (hash + message).
 * @returns Parsed commit or undefined if not conventional format.
 */
function parseCommit(line: string): Commit | undefined {
	const withoutHash = line.replace(/^[a-f0-9]+ /, '')
	const withScope = withoutHash.match(/^(\w+)\(([^)]+)\):\s*(.+)$/)

	if (withScope) {
		return {
			type: withScope[1]!,
			scope: withScope[2]!,
			description: withScope[3]!,
		}
	}

	const withoutScope = withoutHash.match(/^(\w+):\s*(.+)$/)

	if (withoutScope) {
		return {
			type: withoutScope[1]!,
			scope: 'general',
			description: withoutScope[2]!,
		}
	}

	return undefined
}

/**
 * Build a release PR title from unique feat/fix scopes, capped at 72 chars.
 *
 * @param commits - Parsed commits in the range.
 * @returns Release title string.
 */
function buildTitle(commits: Commit[]): string {
	const feats = commits.filter(c => c.type === 'feat')
	const fixes = commits.filter(c => c.type === 'fix')
	const notable = [...feats, ...fixes].length > 0 ? [...feats, ...fixes] : commits

	const seen = new Set<string>()
	const parts: string[] = []
	const prefix = 'release: '

	for (const commit of notable) {
		if (seen.has(commit.scope)) {
			// skip duplicate scopes
		} else {
			seen.add(commit.scope)

			const candidate = prefix + [...parts, commit.scope].join(', ')
			const overflow = candidate.length > MAX_TITLE_LENGTH && parts.length > 0

			if (overflow) {
				break
			}

			parts.push(commit.scope)
		}
	}

	if (parts.length === 0) {
		return 'release: updates'
	}

	return `${prefix}${parts.join(', ')}`
}

/**
 * Build a release PR body with commits grouped by conventional type.
 *
 * @param commits - Parsed commits in the range.
 * @returns Markdown body string.
 */
function buildBody(commits: Commit[]): string {
	const groups: Record<string, Commit[]> = {}

	for (const commit of commits) {
		const label = TYPE_LABELS[commit.type] ?? 'Other'
		const group = groups[label] ?? []

		group.push(commit)
		groups[label] = group
	}

	const sectionOrder = ['Features', 'Fixes', 'Other']
	const sections: string[] = []

	for (const section of sectionOrder) {
		const items = groups[section]

		if (!items || items.length === 0) {
			// eslint-disable-next-line no-continue -- skip empty sections
		} else {
			sections.push(`## ${section}`)

			for (const item of items) {
				sections.push(`- **${item.scope}**: ${item.description}`)
			}

			sections.push('')
		}
	}

	return sections.join('\n').trim()
}

const range = parseRange(process.argv[2])
const lines = getCommitLines(range)

if (lines.length === 0) {
	console.error(`No commits found in range: ${range}`)
	process.exit(1)
}

const commits = lines.map(parseCommit).filter((c): c is Commit => c !== undefined)

if (commits.length === 0) {
	console.error('No conventional commits found in range.')
	process.exit(1)
}

const title = buildTitle(commits)
const body = buildBody(commits)

console.log(JSON.stringify({ title, body }, null, 2))
