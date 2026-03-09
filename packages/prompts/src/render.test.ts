import { describe, expect, test } from 'bun:test'

import { renderPrompt, renderTemplate } from './render.ts'

describe('renderTemplate', () => {
	test('replaces filled slots', () => {
		const result = renderTemplate('Hello {{name}}, welcome to {{place}}.', {
			name: 'Alice',
			place: 'Wonderland',
		})

		expect(result).toBe('Hello Alice, welcome to Wonderland.')
	})

	test('removes empty slots and collapses surrounding newlines', () => {
		const template = ['Line one.', '', '{{optional}}', '', 'Line two.'].join('\n')

		const result = renderTemplate(template, { optional: undefined })

		expect(result).toBe('Line one.\nLine two.')
	})

	test('removes whitespace-only slot values', () => {
		const template = 'Before\n\n{{gap}}\n\nAfter'

		const result = renderTemplate(template, { gap: '   ' })

		expect(result).toBe('Before\nAfter')
	})

	test('replaces multiple occurrences of the same slot', () => {
		const result = renderTemplate('{{x}} and {{x}}', { x: 'yes' })

		expect(result).toBe('yes and yes')
	})

	test('collapses surrounding newlines when slot is removed', () => {
		const template = 'A\n\n{{removed}}\n\n\nB'

		const result = renderTemplate(template, { removed: undefined })

		expect(result).toBe('A\nB')
	})

	test('trims leading and trailing whitespace', () => {
		const result = renderTemplate('\n\n  Hello  \n\n', {})

		expect(result).toBe('Hello')
	})

	test('handles template with no slots', () => {
		const result = renderTemplate('Static text only.', {})

		expect(result).toBe('Static text only.')
	})
})

describe('renderPrompt', () => {
	test('loads and renders execution-system template', () => {
		const result = renderPrompt('execution-system', {
			sourceRepoSection: undefined,
			diffFileSection: undefined,
			pathMappings: undefined,
			namingConventions: undefined,
			additionalInstructions: undefined,
			ignorePatterns: undefined,
		})

		expect(result).toContain('You are a code porting agent')
		expect(result).toContain('Workspace rules')
		expect(result).toContain('Do NOT run validation commands')
		expect(result).toContain('Structured summary')
		expect(result).not.toContain('{{')
	})

	test('loads and renders decision-system template', () => {
		const result = renderPrompt('decision-system', {
			sourceRepoSection: 'Source repository checkout:\n- `/tmp/source`',
			diffFileSection: undefined,
			pathMappings: undefined,
			namingConventions: undefined,
			additionalInstructions: undefined,
			ignorePatterns: undefined,
		})

		expect(result).toContain('classification agent')
		expect(result).toContain('/tmp/source')
		expect(result).not.toContain('{{')
	})

	test('loads and renders execution-user template', () => {
		const result = renderPrompt('execution-user', {
			targetWorkingDirectory: '/tmp/target',
			changedFiles: 'Changed files:\n- `src/app.ts` (modified, +5 / -2)',
			retryFeedback: undefined,
			instruction: 'Apply equivalent changes in the target repository.',
		})

		expect(result).toContain('Port the source changes')
		expect(result).toContain('/tmp/target')
		expect(result).toContain('src/app.ts')
		expect(result).toContain('Apply equivalent changes')
		expect(result).not.toContain('{{')
	})

	test('loads and renders decision-user template', () => {
		const result = renderPrompt('decision-user', {
			targetWorkingDirectory: '/tmp/target',
			changedFiles: 'Changed files:\n- `src/app.ts` (modified, +5 / -2)',
		})

		expect(result).toContain('should be ported')
		expect(result).toContain('/tmp/target')
		expect(result).toContain('src/app.ts')
		expect(result).not.toContain('{{')
	})
})
