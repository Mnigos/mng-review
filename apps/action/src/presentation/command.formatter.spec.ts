import {
	AUTHORIZE_SUMMARY_TITLE,
	formatAuthorizeLogLine,
	formatAuthorizeSummary,
	formatReserveLogLine,
	formatReserveSummary,
	toAuthorizeOutputs,
} from './command.formatter'

describe('authorization output', () => {
	test('denials export only authorized=false, never an untrusted reason', () => {
		expect(
			toAuthorizeOutputs({
				status: 'denied',
				reason: '\nhead_sha=forged\n::error::failure',
			})
		).toEqual({ authorized: 'false' })
	})
	test.each([{}, { depth: 'deep' }, { agent: 'storage' }] as const)(
		'authorized commands export the checked metadata and request %j',
		request => {
			expect(
				toAuthorizeOutputs({
					status: 'authorized',
					pullNumber: 17,
					base: 'base-sha',
					head: 'head-sha',
					...request,
				})
			).toEqual({
				authorized: 'true',
				pull_number: '17',
				base_sha: 'base-sha',
				head_sha: 'head-sha',
				depth: '',
				agent: '',
				...request,
			})
		}
	)
	test.each([
		'::error::failure',
		'\r\n::stop-commands::token\n::add-mask::value',
		'##[error]oops',
		'safe\u001B[31m\u0000\r\n::warning::bad',
	])('cannot emit a workflow command through a denied reason %j', reason => {
		const line = formatAuthorizeLogLine({ status: 'denied', reason })
		expect(line).toContain('mng-review: command not run:')
		expect(line).not.toMatch(/::|##\[/u)
		for (const control of ['\r', '\n', '\u0000', '\u001B'])
			expect(line).not.toContain(control)
	})
	test('escapes markdown, links and HTML in the summary reason', () => {
		const summary = formatAuthorizeSummary({
			status: 'denied',
			reason:
				'<script>alert(1)</script> [open](https://example.test) **admin**',
		})
		expect(summary).toContain(AUTHORIZE_SUMMARY_TITLE)
		expect(summary).toContain('\\<script\\>')
		expect(summary).toContain('\\[open\\]\\(')
		expect(summary).toContain('`https://example.test)`')
		expect(summary).toContain('\\*\\*admin\\*\\*')
		expect(summary).not.toContain('<script>')
	})
	test.each([
		[{}, 'a review'],
		[{ depth: 'deep' }, 'a deep review'],
		[{ agent: 'storage' }, 'agent storage'],
	] as const)('describes the authorized request %j', (request, expected) => {
		const decision = {
			status: 'authorized',
			pullNumber: 17,
			base: 'base',
			head: 'head',
			...request,
		} as const
		expect(formatAuthorizeLogLine(decision)).toContain(
			`command authorized: ${expected} of pull request #17`
		)
		expect(formatAuthorizeSummary(decision)).toContain(expected)
	})
})

describe('command text cannot notify or start another run', () => {
	test.each(['@mng-review review', '@someone', 'reason\n@mng-review review'])(
		'escapes mentions in summaries and flattens logs for %j',
		reason => {
			const decision = { status: 'denied', reason } as const
			const reserve = { reserved: false, reason } as const
			for (const summary of [
				formatAuthorizeSummary(decision),
				formatReserveSummary(reserve),
			]) {
				expect(summary.replaceAll(/`[^`]*`/gu, '')).not.toContain('@')
				expect(summary).toContain('`@')
			}
			for (const line of [
				formatAuthorizeLogLine(decision),
				formatReserveLogLine(reserve),
			]) {
				expect(line).not.toMatch(/[\r\n]/u)
				expect(line).not.toContain('::')
			}
		}
	)
	test('describes a counted reservation without inventing a reason', () => {
		expect(formatReserveLogLine({ reserved: true })).toBe(
			'mng-review: reserve true'
		)
		expect(formatReserveSummary({ reserved: true })).toContain(
			'manual run counted; the review starts'
		)
	})
})
