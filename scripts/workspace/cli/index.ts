#!/usr/bin/env bun
/**
 * Workspace CLI — manage workspace packages.
 *
 * Usage:
 *   bun workspace create [name]
 *   bun workspace create [name] --path packages/
 *   bun workspace remove [name]
 *   bun workspace list
 *   bun workspace clean [--all]
 */
import { Command } from 'commander'

import { clean } from './commands/clean'
import { create } from './commands/create'
import { interactive } from './commands/index'
import { list } from './commands/list'
import { remove } from './commands/remove'

const NO_ARGS_EXPECTED = 2

const program = new Command().name('workspace').description('Manage workspace packages')

program
	.command('create')
	.description('Scaffold a new package')
	.argument('[name]', 'package name')
	.option('--path <packagesDir>', 'workspace directory override (default: packages/)')
	.action((name?: string, opts?: { path?: string }) => create({ name, packagesDir: opts?.path }))

program
	.command('remove')
	.description('Delete a package')
	.argument('[name]', 'package name')
	.option('-y, --yes', 'skip confirmation')
	.action((name?: string, opts?: { yes?: boolean }) => remove({ force: opts?.yes, name }))

program
	.command('list')
	.description('Show all packages')
	.action(async () => {
		await list()
	})

program
	.command('clean')
	.description('Remove build artifacts')
	.option('--all', 'also remove node_modules')
	.action(async (opts: { all?: boolean }) => {
		await clean({ all: opts.all })
	})

await (process.argv.length <= NO_ARGS_EXPECTED ? interactive() : program.parseAsync())
