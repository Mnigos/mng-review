import { defineConfig } from 'oxfmt'
import ultracite from 'ultracite/oxfmt'

export default defineConfig({
	...ultracite,
	arrowParens: 'avoid',
	insertFinalNewline: true,
	proseWrap: 'preserve',
	semi: false,
	singleQuote: true,
	useTabs: true,
	sortImports: { newlinesBetween: false, partitionByNewline: true },
	ignorePatterns: [...(ultracite.ignorePatterns ?? []), 'docs/**'],
	overrides: [
		{
			files: ['**/*.json', '**/*.jsonc'],
			options: { useTabs: false },
		},
	],
})
