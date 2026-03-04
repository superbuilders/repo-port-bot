import { describe, expect, test } from 'bun:test'

import { cloneSourceRepo } from './clone-source-repo.ts'

const COMMAND_COUNT = 5
const DIFF_COMMAND_INDEX = 4

describe('cloneSourceRepo', () => {
	test('clones source repo at sha and writes local diff file', async () => {
		const commandLog: { command: string[]; workingDirectory?: string }[] = []
		const writes: { content: string; path: string }[] = []
		const directory = '/tmp/source-repo'
		const commitSha = 'abc123def'

		const result = await cloneSourceRepo(
			{
				repo: {
					owner: 'acme',
					name: 'source-repo',
				},
				commitSha,
				token: 'ghp_testtoken',
			},
			{
				createTempDirectory: async () => directory,
				runCommand: async input => {
					commandLog.push(input)

					if (input.command.join(' ') === 'git diff HEAD~1') {
						return {
							exitCode: 0,
							stdout: 'diff --git a/src/app.ts b/src/app.ts\n',
							stderr: '',
						}
					}

					return {
						exitCode: 0,
						stdout: '',
						stderr: '',
					}
				},
				writeFile: async (filePath, content) => {
					writes.push({ path: filePath, content })
				},
			},
		)

		expect(result).toEqual({
			sourceWorkingDirectory: directory,
			diffFilePath: '/tmp/source-repo/port-diff.patch',
		})
		expect(commandLog).toHaveLength(COMMAND_COUNT)
		expect(commandLog[0]?.command).toEqual(['git', 'init'])
		expect(commandLog[1]?.command).toEqual([
			'git',
			'remote',
			'add',
			'origin',
			'https://x-access-token:ghp_testtoken@github.com/acme/source-repo.git',
		])
		expect(commandLog[2]?.command).toEqual([
			'git',
			'fetch',
			'--depth',
			'2',
			'origin',
			commitSha,
		])
		expect(commandLog[3]?.command).toEqual(['git', 'checkout', 'FETCH_HEAD'])
		expect(commandLog[DIFF_COMMAND_INDEX]?.command).toEqual(['git', 'diff', 'HEAD~1'])

		for (const command of commandLog) {
			expect(command.workingDirectory).toBe(directory)
		}

		expect(writes).toEqual([
			{
				path: '/tmp/source-repo/port-diff.patch',
				content: 'diff --git a/src/app.ts b/src/app.ts\n',
			},
		])
	})

	test('throws when a git command fails', async () => {
		await expect(
			cloneSourceRepo(
				{
					repo: {
						owner: 'acme',
						name: 'source-repo',
					},
					commitSha: 'abc123',
					token: 'ghp_testtoken',
				},
				{
					createTempDirectory: async () => '/tmp/source-repo',
					runCommand: async () => ({
						exitCode: 1,
						stdout: '',
						stderr: 'fatal: not found',
					}),
					writeFile: async () => {},
				},
			),
		).rejects.toThrow('Command failed')
	})
})
