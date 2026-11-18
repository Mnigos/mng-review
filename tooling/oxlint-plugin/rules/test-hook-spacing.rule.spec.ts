import { RuleTester } from 'oxlint/plugins-dev'
import { testHookSpacingRule } from './test-hook-spacing.rule.mts'

RuleTester.describe = describe
RuleTester.it = test

const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { lang: 'ts' } },
})

ruleTester.run('test-hook-spacing', testHookSpacingRule, {
	valid: [
		"describe('service', () => {\n\tbeforeEach(() => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\tlet b: number\n\tconst setup = createSetup()\n\n\tbeforeEach(() => {})\n\n\tafterEach(() => {})\n\n\ttest('works', () => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\n\t// Prepare the service.\n\tbeforeEach(() => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\n\t/* Prepare the service. */\n\tbeforeEach(() => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\tlet b: number\n\tconst setup = createSetup()\n\tconst repository = createRepository()\n})",
		"describe('service', () => {\n\tbeforeEach(() => {})\n\n\tconst setup = createSetup()\n})",
		"describe('service', () => {\n\tconst setup = createSetup()\n\n\tafterEach(() => {})\n})",
		'const setup = createSetup()\nfoo.beforeEach(() => {})\nrun()',
		'const setup = createSetup()\nfoo.afterEach(() => {})\nfoo.beforeAll(() => {})\nfoo.afterAll(() => {})\nrun()',
		"test.describe('service', () => {\n\tconst setup = createSetup()\n\n\ttest.beforeEach(() => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\n\n\n\tbeforeEach(() => {})\n\n\n\ttest('works', () => {})\n})",
		'beforeAll(() => {})',
		'afterAll(() => {})',
		'test.beforeEach(() => {})',
		'test.afterEach(() => {})',
		'test.beforeAll(() => {})',
		'test.afterAll(() => {})',
		'const setup = createSetup()\r\n\r\nbeforeEach()\r\n',
		"describe('service', () => {\n\tbeforeAll(() => {})\n\n\tafterAll(() => {})\n})",
		"describe('service', () => {\n\tlet a: number\n\n\t/**\n\t * Prepare the service.\n\t */\n\tbeforeEach(() => {})\n})",
		"describe('service', () => {\n\t// Prepare the service.\n\tbeforeEach(() => {})\n})",
		"describe('service', () => {\n\tbeforeEach(() => {}) // Setup complete.\n\n\t// Verify the service.\n\ttest('works', () => {})\n})",
		"describe('service', () => {\n\tfunction setup() {\n\t\tbeforeEach(() => {})\n\t}\n\ttest('works', () => {})\n})",
		'const beforeEach = createHook()\nrun(beforeEach)\nconst afterEach = createHook()',
	],
	invalid: [
		{
			name: 'separates hooks and the following test without splitting the let group',
			code: "describe('service', () => {\n\tlet a: number\n\tlet b: number\n\tbeforeEach(() => {})\n\tafterEach(() => {})\n\ttest('works', () => {})\n})",
			output:
				"describe('service', () => {\n\tlet a: number\n\tlet b: number\n\n\tbeforeEach(() => {})\n\n\tafterEach(() => {})\n\n\ttest('works', () => {})\n})",
			errors: [
				{
					message:
						'Separate lifecycle hooks from sibling statements with a blank line (AGENTS.md).',
					line: 4,
				},
				{ messageId: 'missingBlankLineAroundHook', line: 5 },
				{ messageId: 'missingBlankLineAroundHook', line: 6 },
			],
		},
		{
			name: 'inserts the blank line above an attached own-line comment',
			code: "describe('service', () => {\n\tlet a: number\n\t// Prepare the service.\n\tbeforeEach(() => {})\n})",
			output:
				"describe('service', () => {\n\tlet a: number\n\n\t// Prepare the service.\n\tbeforeEach(() => {})\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 4 }],
		},
		{
			name: 'keeps the trailing comment with the hook and the own-line comment with the test',
			code: "describe('service', () => {\n\tbeforeEach(() => {}) // Setup complete.\n\t// Verify the service.\n\ttest('works', () => {})\n})",
			output:
				"describe('service', () => {\n\tbeforeEach(() => {}) // Setup complete.\n\n\t// Verify the service.\n\ttest('works', () => {})\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 4 }],
		},
		{
			name: 'inserts exactly one CRLF without changing existing line endings',
			code: 'let a\r\nbeforeEach()\r\n',
			output: 'let a\r\n\r\nbeforeEach()\r\n',
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 2 }],
		},
		{
			name: 'separates top-level imports and consecutive all hooks',
			code: "import { setup } from './setup'\nafterAll(() => {})\nbeforeAll(() => {})",
			output:
				"import { setup } from './setup'\n\nafterAll(() => {})\n\nbeforeAll(() => {})",
			errors: [
				{ messageId: 'missingBlankLineAroundHook', line: 2 },
				{ messageId: 'missingBlankLineAroundHook', line: 3 },
			],
		},
		{
			name: 'separates a const from a Playwright beforeEach hook',
			code: "test.describe('service', () => {\n\tconst setup = createSetup()\n\ttest.beforeEach(() => {})\n})",
			output:
				"test.describe('service', () => {\n\tconst setup = createSetup()\n\n\ttest.beforeEach(() => {})\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 3 }],
		},
		{
			name: 'inserts the blank line above a multiline block comment ending immediately before the hook',
			code: "describe('service', () => {\n\tlet a: number\n\t/**\n\t * Prepare the service.\n\t */\n\tbeforeEach(() => {})\n})",
			output:
				"describe('service', () => {\n\tlet a: number\n\n\t/**\n\t * Prepare the service.\n\t */\n\tbeforeEach(() => {})\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 6 }],
		},
		{
			name: 'checks sibling statements inside a nested function',
			code: "describe('service', () => {\n\tfunction setup() {\n\t\tconst repository = createRepository()\n\t\tbeforeEach(() => {})\n\t\trun()\n\t}\n})",
			output:
				"describe('service', () => {\n\tfunction setup() {\n\t\tconst repository = createRepository()\n\n\t\tbeforeEach(() => {})\n\n\t\trun()\n\t}\n})",
			errors: [
				{ messageId: 'missingBlankLineAroundHook', line: 4 },
				{ messageId: 'missingBlankLineAroundHook', line: 5 },
			],
		},
		{
			name: 'checks sibling statements inside a test body',
			code: "test('works', () => {\n\tprepare()\n\tafterEach(() => {})\n\tverify()\n})",
			output:
				"test('works', () => {\n\tprepare()\n\n\tafterEach(() => {})\n\n\tverify()\n})",
			errors: [
				{ messageId: 'missingBlankLineAroundHook', line: 3 },
				{ messageId: 'missingBlankLineAroundHook', line: 4 },
			],
		},
		{
			name: 'checks only the following boundary when beforeAll opens a block',
			code: "describe('service', () => {\n\tbeforeAll(() => {})\n\tconst setup = createSetup()\n})",
			output:
				"describe('service', () => {\n\tbeforeAll(() => {})\n\n\tconst setup = createSetup()\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 3 }],
		},
		{
			name: 'checks only the preceding boundary when afterAll closes a block',
			code: "describe('service', () => {\n\tconst setup = createSetup()\n\tafterAll(() => {})\n})",
			output:
				"describe('service', () => {\n\tconst setup = createSetup()\n\n\tafterAll(() => {})\n})",
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 3 }],
		},
		{
			name: 'separates every Playwright hook from its siblings',
			code: 'prepare()\ntest.beforeAll(() => {})\ntest.beforeEach(() => {})\ntest.afterEach(() => {})\ntest.afterAll(() => {})\nverify()',
			output:
				'prepare()\n\ntest.beforeAll(() => {})\n\ntest.beforeEach(() => {})\n\ntest.afterEach(() => {})\n\ntest.afterAll(() => {})\n\nverify()',
			errors: [
				{ messageId: 'missingBlankLineAroundHook', line: 2 },
				{ messageId: 'missingBlankLineAroundHook', line: 3 },
				{ messageId: 'missingBlankLineAroundHook', line: 4 },
				{ messageId: 'missingBlankLineAroundHook', line: 5 },
				{ messageId: 'missingBlankLineAroundHook', line: 6 },
			],
		},
		{
			name: 'keeps several attached comments together above a hook',
			code: 'let a\n// Prepare the service.\n/* Reset the repository. */\nbeforeEach(() => {})',
			output:
				'let a\n\n// Prepare the service.\n/* Reset the repository. */\nbeforeEach(() => {})',
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 4 }],
		},
		{
			name: 'keeps an earlier trailing comment above the inserted blank line',
			code: 'let a // Shared state.\n// Prepare the service.\nbeforeEach(() => {})',
			output:
				'let a // Shared state.\n\n// Prepare the service.\nbeforeEach(() => {})',
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 3 }],
		},
		{
			name: 'does not count empty lines inside a block comment as sibling separation',
			code: 'let a\n/* Prepare\n\nthe service. */\nbeforeEach(() => {})',
			output: 'let a\n\n/* Prepare\n\nthe service. */\nbeforeEach(() => {})',
			errors: [{ messageId: 'missingBlankLineAroundHook', line: 5 }],
		},
		{
			name: 'preserves CRLF around attached and trailing comments',
			code: 'let a // Shared state.\r\n// Prepare the service.\r\nbeforeEach()\r\nverify()\r\n',
			output:
				'let a // Shared state.\r\n\r\n// Prepare the service.\r\nbeforeEach()\r\n\r\nverify()\r\n',
			errors: [
				{ messageId: 'missingBlankLineAroundHook', line: 3 },
				{ messageId: 'missingBlankLineAroundHook', line: 4 },
			],
		},
	],
})
