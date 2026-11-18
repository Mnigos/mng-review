import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			'apps/*/vitest.config.ts',
			'packages/*/vitest.config.ts',
			{
				test: {
					name: '@mng-review/oxlint-plugin',
					globals: true,
					include: ['tooling/oxlint-plugin/**/*.spec.ts'],
				},
			},
		],
	},
})
