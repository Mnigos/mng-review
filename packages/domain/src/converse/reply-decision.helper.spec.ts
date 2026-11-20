import type { Severity } from '../config/review-config.schema'
import { config, file, finding } from '../shared/mocks/domain-test.helper'
import type { Judgement, Validation } from '../validation/validation.types'
import {
	getIntentionalLimit,
	toMemoryCandidate,
	toReplyClaim,
	toReplyDecision,
	type ReplyDecisionInput,
} from './reply-decision.helper'
import {
	MEMORY_REASON_MAX_CHARS,
	REPLY_REASON_MAX_CHARS,
} from './reply.constants'
import type { ReplyClaim, ReplyItem } from './reply.types'

/** A decision input whose independent premises can be overridden. */
function input(
	overrides: Partial<ReplyDecisionInput> = {}
): ReplyDecisionInput {
	return {
		item: {
			finding: finding(),
			base: 'base',
			reply: 'Raw author text must not enter memory.',
			disputes: 0,
		},
		claim: {
			claim: 'intentional',
			holds: true,
			reason: 'The ledger uses integer cents.',
			evidence: ['src/money.ts:2'],
		},
		config: config(),
		limit: 'ok',
		checkedEvidence: ['src/money.ts:2'],
		commitSince: true,
		...overrides,
	}
}
/** Keeps finding identity while exercising earlier dispute counts. */
function item(disputes: number): ReplyItem {
	return { ...input().item, disputes }
}
/** A usable recheck verdict at the head. */
function validation(status: 'confirmed' | 'rejected'): Judgement {
	return {
		status,
		severity: 'medium',
		reason: 'The validator checked the head.',
		evidence: ['src/money.ts:2'],
		model: 'validator',
	}
}

describe('toReplyDecision', () => {
	test.each([0, 1, 20])(
		'unclear is only seen after %s disputes despite limits',
		disputes => {
			expect(
				toReplyDecision(
					input({
						item: item(disputes),
						claim: { claim: 'unclear', evidence: [] },
						limit: 'critical',
					})
				)
			).toEqual({ action: 'seen' })
		}
	)
	test.each([0, 1, 20])(
		'fixed without a changed file remains found after %s disputes',
		disputes => {
			expect(
				toReplyDecision(
					input({
						item: item(disputes),
						claim: { claim: 'fixed', evidence: [] },
						commitSince: false,
						recheck: validation('rejected'),
					})
				)
			).toEqual({
				action: 'still-found',
				reason: 'no commit since has changed this file',
			})
		}
	)
	test.each([0, 1, 20])(
		'fixed with a rejecting validator resolves after %s disputes',
		disputes => {
			expect(
				toReplyDecision(
					input({
						item: item(disputes),
						claim: { claim: 'fixed', evidence: [] },
						limit: 'critical',
						recheck: validation('rejected'),
					})
				)
			).toEqual({
				action: 'resolved',
				reason: 'The validator checked the head.',
			})
		}
	)
	test.each([
		['confirmed', validation('confirmed')],
		[
			'unverified',
			{
				...validation('confirmed'),
				status: 'unverified',
				premise: 'External behavior.',
			},
		],
		['unvalidated', { status: 'unvalidated', error: 'Model unavailable.' }],
		['missing', undefined],
	] as const satisfies readonly (readonly [string, Validation | undefined])[])(
		'fixed with %s validation remains found',
		(_name, recheck) => {
			const decision = toReplyDecision(
				input({
					claim: { claim: 'fixed', evidence: [] },
					...(recheck ? { recheck } : {}),
				})
			)
			expect(decision.action).toBe('still-found')
			if (recheck?.status === 'confirmed' || recheck?.status === 'unverified')
				expect(decision).toHaveProperty('reason', recheck.reason)
		}
	)
	test.each(['critical', 'severity', 'risk_paths'] as const)(
		'%s takes precedence over holding evidence',
		limit => {
			expect(toReplyDecision(input({ limit })).action).toBe('needs-owner')
		}
	)
	test('holding checked evidence is accepted even after the dispute limit', () => {
		expect(toReplyDecision(input({ item: item(20) }))).toEqual({
			action: 'accepted',
			reason: 'The ledger uses integer cents.',
			memory: `${input().item.finding.path}: The ledger uses integer cents.`,
			evidence: ['src/money.ts:2'],
		})
	})
	test('holds without checked evidence is disputed with the missing evidence', () => {
		const decision = toReplyDecision(input({ checkedEvidence: [] }))
		expect(decision.action).toBe('disputed')
		expect(decision).toHaveProperty(
			'reason',
			expect.stringContaining('evidence')
		)
	})
	test('checked evidence without holds is disputed with the failed premise', () => {
		expect(
			toReplyDecision(
				input({
					claim: {
						...input().claim,
						holds: false,
						failedPremise: 'The code rounds dollars.',
					},
				})
			)
		).toEqual({ action: 'disputed', reason: 'The code rounds dollars.' })
	})
	test.each([
		[1, 0, 'disputed'],
		[1, 1, 'needs-owner'],
		[0, 0, 'needs-owner'],
		[2, 0, 'disputed'],
		[2, 1, 'disputed'],
		[2, 2, 'needs-owner'],
	] as const)(
		'max rounds %s with %s disputes gives %s',
		(max_rounds, disputes, action) => {
			expect(
				toReplyDecision(
					input({
						item: item(disputes),
						config: config({ disputes: { max_rounds } }),
						checkedEvidence: [],
					})
				).action
			).toBe(action)
		}
	)
	test('accepted memory uses the model restatement rather than the author reply', () => {
		const fixture = input({
			claim: { ...input().claim, reason: 'Integer\ncents.\r\n  Stable units.' },
		})
		const decision = toReplyDecision(fixture)
		expect(decision).toHaveProperty(
			'memory',
			`${fixture.item.finding.path}: Integer cents. Stable units.`
		)
		expect(JSON.stringify(decision)).not.toContain(fixture.item.reply)
	})
})

describe('getIntentionalLimit', () => {
	test.each([
		['low', 'ok'],
		['medium', 'ok'],
		['high', 'severity'],
		['critical', 'critical'],
	] as const)(
		'uses the bot marker severity %s at a medium limit',
		(severity, expected) => {
			expect(
				getIntentionalLimit(finding({ severity }), config(), { files: [] })
			).toBe(expected)
		}
	)
	test('critical still needs the owner when critical is the configured limit', () => {
		expect(
			getIntentionalLimit(
				finding({ severity: 'critical' }),
				config({ disputes: { accept_intentional_up_to: 'critical' } }),
				{ files: [] }
			)
		).toBe('critical')
	})
	test.each(['low', 'medium', 'high'] as const satisfies readonly Severity[])(
		'risk paths send %s severity to the owner',
		severity => {
			const marker = finding({ path: 'src/money/nested/charge.ts', severity })
			const cfg = config({ risk_paths: ['src/{money,auth}/**/*.ts'] })
			expect(
				toReplyDecision(
					input({
						item: { ...item(0), finding: marker },
						config: cfg,
						limit: getIntentionalLimit(marker, cfg, {
							files: [file(marker.path)],
						}),
					})
				).action
			).toBe('needs-owner')
		}
	)
	test('matches a rename at its old risk path', () => {
		const marker = finding({ path: 'src/store.ts', severity: 'low' })
		expect(
			getIntentionalLimit(marker, config({ risk_paths: ['src/money/**'] }), {
				files: [
					file(marker.path, {
						status: 'renamed',
						oldPath: 'src/money/charge.ts',
					}),
				],
			})
		).toBe('risk_paths')
	})
	test('does not match a neighboring directory', () => {
		expect(
			getIntentionalLimit(
				finding({ path: 'src/moneys/charge.ts', severity: 'low' }),
				config({ risk_paths: ['src/money/**'] }),
				{ files: [] }
			)
		).toBe('ok')
	})
})

describe('toReplyClaim', () => {
	test('keeps intentional premises with evidence', () => {
		expect(
			toReplyClaim({
				claim: 'intentional',
				holds: false,
				reason: 'Uses dollars.',
				failed_premise: 'Units differ.',
				evidence: ['src/money.ts:2'],
			})
		).toEqual({
			claim: 'intentional',
			holds: false,
			reason: 'Uses dollars.',
			failedPremise: 'Units differ.',
			evidence: ['src/money.ts:2'],
		} satisfies ReplyClaim)
	})
	test.each(['fixed', 'unclear'] as const)(
		'%s omits intentional-only fields',
		claim => {
			expect(
				toReplyClaim({
					claim,
					holds: true,
					reason: 'Restatement.',
					failed_premise: 'Ignore this.',
					evidence: [],
				})
			).toEqual({ claim, reason: 'Restatement.', evidence: [] })
		}
	)
})

describe('toMemoryCandidate', () => {
	test('collapses line breaks and whitespace in the reason and path', () => {
		expect(
			toMemoryCandidate(
				{ path: 'src/money.ts\n' },
				'  Integer\ncents.\r\n   Stable\tunits.  '
			)
		).toBe('src/money.ts: Integer cents. Stable units.')
	})
	test('cuts the reason at the exported character limit', () => {
		const reason = 'x'.repeat(MEMORY_REASON_MAX_CHARS + 20)
		const memory = toMemoryCandidate({ path: 'src/money.ts' }, reason)
		expect(memory.slice('src/money.ts: '.length)).toHaveLength(
			MEMORY_REASON_MAX_CHARS
		)
		expect(memory).toContain('x'.repeat(MEMORY_REASON_MAX_CHARS - 1))
		expect(memory).not.toContain(reason)
		expect(memory).not.toMatch(/[\r\n]/u)
	})
})

describe('reply decision output bounds', () => {
	test.each([
		'accepted',
		'resolved',
		'still-found',
		'disputed',
		'needs-owner',
	] as const)('cuts every %s reason to one bounded line', action => {
		const reason = `  ${'x'.repeat(REPLY_REASON_MAX_CHARS + 50)}\n tail  `
		const claim =
			action === 'resolved' || action === 'still-found'
				? ({ claim: 'fixed', evidence: [] } as const)
				: {
						...input().claim,
						reason,
						failedPremise: reason,
						holds: action !== 'disputed',
					}
		const decision = toReplyDecision(
			input({
				claim,
				...(action === 'resolved' || action === 'still-found'
					? {
							recheck: {
								...validation(action === 'resolved' ? 'rejected' : 'confirmed'),
								reason,
							},
						}
					: {}),
				...(action === 'needs-owner'
					? {
							item: { ...item(0), finding: finding({ path: reason }) },
							limit: 'risk_paths',
						}
					: {}),
			})
		)
		expect(decision.action).toBe(action)
		if (decision.action === 'seen') return
		expect(decision.reason).toHaveLength(REPLY_REASON_MAX_CHARS)
		expect(decision.reason.endsWith('…')).toBe(true)
		expect(decision.reason).not.toMatch(/[\r\n]/u)
	})
	test('a finding at the old path matches the new risk path', () => {
		const marker = finding({ path: 'src/store.ts', severity: 'low' })
		expect(
			getIntentionalLimit(marker, config({ risk_paths: ['src/risk/**'] }), {
				files: [
					file('src/risk/store.ts', {
						status: 'renamed',
						oldPath: marker.path,
					}),
				],
			})
		).toBe('risk_paths')
	})
	test('memory replaces markup, code delimiters and mentions in reason and path with spaces', () => {
		const memory = toMemoryCandidate(
			{ path: 'src/<policy>@file`name`.ts' },
			'<!-- policy --> uses `integer cents` per @reviewer'
		)
		expect(memory).toBe(
			'src/ policy file name .ts: -- policy -- uses integer cents per reviewer'
		)
		expect(memory).not.toMatch(/[<>`@]/u)
	})
})

describe('memory candidate render syntax', () => {
	test.each([
		'[x](https://e.com)',
		'![a](b.png)',
		'https://e.com/x',
		'www.e.com',
		'WWW.E.COM',
		'@user',
		'`code`',
		'<img src=x>',
	])(
		'sanitizes %j in both the path and reason before enforcing the reason cap',
		text => {
			const path = `src/${text}/policy.ts`
			const memory = toMemoryCandidate(
				{ path },
				`${text} ${'policy '.repeat(40)}`
			)
			expect(memory).not.toMatch(/[[\]!@`<>]|:\/\/|www\./iu)
			expect(memory).toContain('/policy.ts: ')
			const reason = memory.slice(
				memory.indexOf('/policy.ts: ') + '/policy.ts: '.length
			)
			expect(reason.length).toBeLessThanOrEqual(MEMORY_REASON_MAX_CHARS)
			expect(reason.endsWith('…')).toBe(true)
			expect(memory).not.toMatch(/[\r\n]/u)
		}
	)
})
