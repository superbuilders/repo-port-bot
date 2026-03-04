import { describe, expect, test } from 'bun:test'

import { cloneTargetRepo } from './clone-target-repo.ts'

describe('cloneTargetRepo', () => {
	test('clones target repo and configures git identity', async () => {
		const commandLog: { command: string[]; workingDirectory?: string }[] = []
		const directory = '/tmp/target-repo'

		const result = await cloneTargetRepo(
			{
				repo: {
					owner: 'acme',
					name: 'target-repo',
				},
				defaultBranch: 'main',
				token: 'ghp_testtoken',
			},
			{
				createTempDirectory: async () => directory,
				runCommand: async input => {
					commandLog.push(input)

					return {
						exitCode: 0,
						stdout: '',
						stderr: '',
					}
				},
			},
		)

		expect(result).toBe(directory)
		expect(commandLog).toHaveLength(3)
		expect(commandLog[0]?.command).toEqual([
			'git',
			'clone',
			'--depth',
			'1',
			'--branch',
			'main',
			'https://x-access-token:ghp_testtoken@github.com/acme/target-repo.git',
			directory,
		])
		expect(commandLog[1]?.command).toEqual(['git', 'config', 'user.name', 'repo-port-bot[bot]'])
		expect(commandLog[2]?.command).toEqual([
			'git',
			'config',
			'user.email',
			'repo-port-bot[bot]@users.noreply.github.com',
		])
		expect(commandLog[1]?.workingDirectory).toBe(directory)
		expect(commandLog[2]?.workingDirectory).toBe(directory)
	})

	test('throws when clone command fails', async () => {
		await expect(
			cloneTargetRepo(
				{
					repo: {
						owner: 'acme',
						name: 'target-repo',
					},
					defaultBranch: 'main',
					token: 'ghp_testtoken',
				},
				{
					createTempDirectory: async () => '/tmp/target-repo',
					runCommand: async () => ({
						exitCode: 1,
						stdout: '',
						stderr: 'fatal: auth failed',
					}),
				},
			),
		).rejects.toThrow('Command failed')
	})
})
