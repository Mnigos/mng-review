import { Yaml } from 'effect/encoding'
import { toYamlText, type YamlMapping } from './yaml-text.util'

for (const value of [
	'**/*.ts',
	"'quote'",
	'#',
	'label: value',
	' leading',
	'true',
	'false',
	'null',
	'42',
	'1.5',
	'',
	'Zażółć gęślą jaźń',
])
	test(`round trips the string ${JSON.stringify(value)}`, () => {
		expect(Yaml.parse(toYamlText({ value }))).toEqual({ value })
	})

for (const [name, value] of [
	[
		'nested mappings',
		{ when: { paths: ['src/**'], nested: { enabled: true, count: 2 } } },
	],
	[
		'lists of mappings',
		{
			agents: [
				{ name: 'billing', paths: ['src/billing/**'] },
				{ name: 'docs', enabled: false },
			],
		},
	],
	[
		'empty lists and mappings',
		{
			list: [],
			mapping: {},
			nested: { list: [], mapping: {} },
			items: [[], {}],
		},
	],
	['empty root mapping', {}],
	[
		'quoted mapping keys',
		{ '#': 'hash', 'with: space': 'colon', true: 'boolean', '': 'empty' },
	],
] as const satisfies readonly (readonly [string, YamlMapping])[])
	test(`round trips ${name}`, () => {
		expect(Yaml.parse(toYamlText(value))).toEqual(value)
	})

test('writes simple words without quotes and ends with a newline', () => {
	expect(
		toYamlText({
			title: 'Example conventions',
			path: 'src/billing',
			enabled: true,
			count: 2,
		})
	).toBe(
		'title: Example conventions\npath: src/billing\nenabled: true\ncount: 2\n'
	)
})

test('round trips a multiline string without folding line breaks', () => {
	const value = { text: 'First line\nSecond line\n', tab: 'a\tb' } as const
	expect(Yaml.parse(toYamlText(value))).toEqual(value)
})
