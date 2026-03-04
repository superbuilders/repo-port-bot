import { basename } from 'node:path'

const typeLocations = {
	create(context) {
		const file = context.filename ?? context.getFilename()
		const name = basename(file)

		if (
			name === 'types.ts' ||
			name.endsWith('.types.ts') ||
			name.endsWith('.gen.ts') ||
			file.includes('/types/')
		) {
			return {}
		}

		return {
			ExportNamedDeclaration(node) {
				if (node.declaration?.type === 'TSInterfaceDeclaration') {
					context.report({ messageId: 'interface', node: node.declaration })
				}

				if (node.declaration?.type === 'TSTypeAliasDeclaration') {
					context.report({ messageId: 'type', node: node.declaration })
				}
			},
		}
	},
	meta: {
		messages: {
			interface:
				'Exported interfaces should live in a nearby types.ts file or types/ directory.',
			type: 'Exported type aliases should live in a nearby types.ts file or types/ directory.',
		},
		type: 'suggestion',
	},
}

export default {
	meta: { name: 'hness' },
	rules: { 'type-locations': typeLocations },
}
