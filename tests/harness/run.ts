/**
 * Pipeline runner and git assertion helpers for scenario tests.
 */
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { runPort } from '../../packages/engine/src/index.ts'
import { createConsoleLogger } from '../../packages/logger/src/index.ts'
import { createScriptedAgent } from './agent.ts'
import { createLocalReader } from './reader.ts'

import type { PortRunResult } from '../../packages/engine/src/index.ts'
import type { RunScenarioOptions } from './types.ts'

export type { RunScenarioOptions } from './types.ts'

const SOURCE_REPO = { owner: 'acme', name: 'source-repo', defaultBranch: 'main' }

/**
 * Run the full pipeline for a scenario test.
 *
 * @param options - Scenario options.
 * @returns Pipeline run result.
 */
export async function runScenario(options: RunScenarioOptions): Promise<PortRunResult> {
	return runPort({
		reader: createLocalReader(options.sourceChange),
		writer: options.writer,
		agentProvider: options.agentProvider ?? createScriptedAgent(options.repos.targetDir),
		sourceRepo: SOURCE_REPO,
		commitSha: options.sourceChange.mergedCommitSha,
		targetWorkingDirectory: options.repos.targetDir,
		sourceWorkingDirectory: options.repos.sourceDir,
		portBotJson: options.portBotJson ?? { target: 'acme/target-repo' },
		logger: createConsoleLogger('warn'),
		maxAttempts: options.maxAttempts,
	})
}

// ---------------------------------------------------------------------------
// Git assertion helpers
// ---------------------------------------------------------------------------

/**
 * List branch names in the target repo.
 *
 * @param targetDir - Target repo working directory.
 * @returns Branch names.
 */
export function listBranches(targetDir: string): string[] {
	const result = spawnSync('git', ['branch', '--list', '--format=%(refname:short)'], {
		cwd: targetDir,
		stdio: 'pipe',
	})

	return (result.stdout?.toString() ?? '').trim().split('\n').filter(Boolean)
}

/**
 * Check whether a file exists at the given path in the target repo.
 *
 * @param targetDir - Target repo working directory.
 * @param path - Repo-relative file path.
 * @returns Whether the file exists.
 */
export async function fileExists(targetDir: string, path: string): Promise<boolean> {
	try {
		await stat(join(targetDir, path))

		return true
	} catch {
		return false
	}
}

/**
 * Read a file from the target repo.
 *
 * @param targetDir - Target repo working directory.
 * @param path - Repo-relative file path.
 * @returns File content as UTF-8 string.
 */
export async function readTargetFile(targetDir: string, path: string): Promise<string> {
	return readFile(join(targetDir, path), 'utf8')
}

/**
 * List files in a directory within the target repo.
 *
 * @param targetDir - Target repo working directory.
 * @param path - Repo-relative directory path.
 * @returns File and directory names.
 */
export async function listTargetDir(targetDir: string, path: string): Promise<string[]> {
	return readdir(join(targetDir, path))
}
