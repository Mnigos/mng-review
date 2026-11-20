import { parseMentionCommand } from './mention-command.parser'

describe('parseMentionCommand', () => {
	test.each([
		['@mng-review review', {}],
		['@mng-review review deep', { depth: 'deep' }],
		['@mng-review review quick', { depth: 'quick' }],
		['@mng-review run storage', { agent: 'storage' }],
		['@MNG-REVIEW review', {}],
		['@mng-review run agent-1.test_name', { agent: 'agent-1.test_name' }],
		...['review', 'deep', 'quick'].map(
			agent => [`@mng-review run ${agent}`, { agent }] as const
		),
		[`@mng-review run ${'a'.repeat(64)}`, { agent: 'a'.repeat(64) }],
		['Paragraph\n@mng-review review deep', { depth: 'deep' }],
		['Paragraph\r\n@mng-review review quick', { depth: 'quick' }],
		['a\r\n@mng-review review', {}],
		['@mng-review review quick\n@mng-review review deep', { depth: 'quick' }],
		['@mng-review run x\n@mng-review review', { agent: 'x' }],
		['<!-- hidden -->\n@mng-review review', {}],
		['<!-- hidden --> @mng-review review', {}],
		['<!-- first --><!-- second --> @mng-review review', {}],
		['<!--\n@mng-review review deep\n-->\n@mng-review review', {}],
		['<!--\n~~~\n-->\n@mng-review review', {}],
		['<!-- ~~~ -->\n@mng-review review', {}],
		['    <!-- x\n@mng-review review', {}],
		['\t<!-- x\n@mng-review review', {}],
		['    code\n@mng-review review', {}],
		['\tcode\n@mng-review review', {}],
		[
			'<!-- first --><!-- second\n@mng-review review deep\n-->\n@mng-review review',
			{},
		],
		['<!-- first\n--><!-- second --> @mng-review review', {}],
		[
			'<!-- first\n--><!-- second\n@mng-review review deep\n--> @mng-review review',
			{},
		],
		['> quoted paragraph\n\n@mng-review review', {}],
		['   > quoted paragraph\n \t\n@mng-review review', {}],
		['> q\n \t\n@mng-review review', {}],
		['```a`b\n@mng-review review', {}],
		['> quoted example\n~~~\nexample\n~~~\n\n@mng-review review', {}],
		['> quoted example\n~~~\n\n~~~\n\n@mng-review review', {}],
		['~~~\n<!--\n~~~\n-->\n@mng-review review', {}],
		['```\n<!--\n```\n-->\n@mng-review review', {}],
		['~~~\n<!--\n~~~\n@mng-review review', {}],
		[
			'```ts\n@mng-review review deep\n````\n@mng-review run storage',
			{ agent: 'storage' },
		],
		[
			'~~~\n@mng-review review deep\n~~~~\n@mng-review review quick',
			{ depth: 'quick' },
		],
		['````\n```\n@mng-review review deep\n`````\n@mng-review review', {}],
		['~~~\n```\n@mng-review review deep\n~~~\n@mng-review review', {}],
		['```\n``` extra\n@mng-review review deep\n```\n@mng-review review', {}],
	] as const)('reads the first standalone command in %j', (body, expected) => {
		expect(parseMentionCommand(body, 'mng-review')).toEqual(expected)
	})

	for (const indent of ['', ' ', '  ', '   '])
		for (const separator of [' ', '\t', '   ', ' \t '])
			for (const [words, expected] of [
				[['review'], {}],
				[['review', 'deep'], { depth: 'deep' }],
				[['review', 'quick'], { depth: 'quick' }],
				[['run', 'storage'], { agent: 'storage' }],
			] as const)
				test(`accepts ${words.join(' ')} with indent ${JSON.stringify(indent)} and separator ${JSON.stringify(separator)}`, () => {
					expect(
						parseMentionCommand(
							`${indent}@mng-review${separator}${words.join(separator)} \t`,
							'mng-review'
						)
					).toEqual(expected)
				})

	test.each([
		'',
		'@mng-review',
		'@mng-review help',
		'@mng-review Review',
		'@mng-review review DEEP',
		'@mng-review Run storage',
		'@mng-review[bot] review',
		'@mng-review: review',
		'@mng-review, review',
		'@mng-review-dev review',
		'@mng-reviewer review',
		'mng-review review',
		'/mng-review',
		'@mng-review review deep quick',
		'@mng-review review fast',
		'@mng-review run',
		'@mng-review run a b',
		`@mng-review run ${'a'.repeat(65)}`,
		'@mng-review run -x',
		'@mng-review run ../x',
		'please @mng-review review',
		'@mng-review review please',
		'@mng-review review # comment',
		'    @mng-review review',
		'\t@mng-review review',
		'   \t@mng-review review',
		'para\n    @mng-review review',
		'text\r```\n@mng-review review\n```',
		'```\n@mng-review review\n```',
		'~~~\n@mng-review review\n~~~',
		'~~~a`b\n@mng-review review\n~~~',
		'   ```\n@mng-review review\n   ```',
		'   ~~~\n@mng-review review\n   ~~~',
		'```\n@mng-review review',
		'~~~\n@mng-review review',
		'````\n```\n@mng-review review',
		'~~~~\n~~~\n@mng-review review',
		'<!-- @mng-review review -->',
		'<!--\n@mng-review review\n-->',
		'paragraph\n    <!--\n@mng-review review\n-->',
		'<!--\u2028hidden\n@mng-review review\n-->',
		'<!--\u2029hidden\n@mng-review review\n-->',
		'<!--\rhidden\n@mng-review review\n-->',
		'    <!--\n~~~\n-->\n@mng-review review\n~~~',
		'\t<!--\n~~~\n-->\n@mng-review review\n~~~',
		'<!--\n~~~\n@mng-review review\n~~~\n-->',
		'<!-- open\n@mng-review review',
		'<!-- first --><!-- second\n@mng-review review',
		'<!-- first\n--><!-- second\n@mng-review review',
		'<!-- first --><!-- @mng-review review -->',
		['~~~', '<!--', '~~~', '-->', '~~~', '@mng-review review', '~~~'].join(
			'\n'
		),
		['```', '<!--', '```', '-->', '```', '@mng-review review', '```'].join(
			'\n'
		),
		'> @mng-review review',
		'   > @mng-review review',
		'> quoted paragraph\n@mng-review review',
		'> quoted\n\u00A0\n@mng-review review',
		'   > quoted paragraph\n@mng-review review',
		'> quoted example\n~~~\nexample\n~~~\n@mng-review review',
		'> quoted example\n```\nexample\n```\n@mng-review review',
		'> quoted example\n~~~\n\n~~~\n@mng-review review',
		'> quoted example\n~~~\n \t\n~~~\n@mng-review review',
		'> quoted example\n~~~\nexample\n~~~\n<!-- hidden -->\n@mng-review review',
		'> quoted example\n~~~\nexample\n~~~\n<!--\n\n-->\n@mng-review review',
	])('ignores %j', body => {
		expect(parseMentionCommand(body, 'mng-review')).toBeUndefined()
	})

	for (const fence of ['```', '~~~'])
		for (const indent of ['', ' ', '  ', '   ', '    ', '\t', ' \t'])
			test(`closing ${fence} with indent ${JSON.stringify(indent)} respects the code boundary`, () => {
				const body = `${fence}\n${indent}${fence}\n@mng-review review`
				expect(parseMentionCommand(body, 'mng-review')).toEqual(
					indent.length <= 3 && !indent.includes('\t') ? {} : undefined
				)
			})

	test.each(['a b', '.*', '', 'a'.repeat(40)])(
		'rejects invalid handle %j without throwing',
		handle => {
			expect(parseMentionCommand('@mng-review review', handle)).toBeUndefined()
		}
	)

	test('matches a mixed-case configured handle', () => {
		expect(parseMentionCommand('@mng-review review', 'MnG-ReViEw')).toEqual({})
	})

	test('finds a command at the end of a maximum-size body', () => {
		const command = '@mng-review review quick'
		const body = `${'x'.repeat(65_536 - command.length - 1)}\n${command}`
		expect(body).toHaveLength(65_536)
		expect(parseMentionCommand(body, 'mng-review')).toEqual({ depth: 'quick' })
	})

	test('completes a maximum-size comment with repeated unclosed comment openers', () => {
		const suffix = '\n@mng-review review'
		const body =
			'<!--'
				.repeat(16_384 - suffix.length)
				.padEnd(65_536 - suffix.length, 'x') + suffix
		expect(body).toHaveLength(65_536)
		expect(parseMentionCommand(body, 'mng-review')).toBeUndefined()
	})
})
