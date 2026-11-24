import { HEAD_DISPATCH_AT, RISK_JOB_NAMES } from './risk.constants'
import {
	countHeadDispatches,
	getDispatchVerdict,
	isJobNamed,
	parseDecideJobName,
	toDecideJobName,
	toDispatchInputs,
} from './sweep-dispatch.helper'

const KEY = {
	kind: 'converse',
	id: 42,
	digest: 'a'.repeat(16),
	at: '2026-01-01T12:00:00Z',
	head: 'b'.repeat(40),
} as const

describe('sweep dispatch decisions', () => {
	test('round trips the decide key with its kind, edit time, digest and full head', () => {
		expect(parseDecideJobName(toDecideJobName(KEY))).toEqual(KEY)
		expect(
			parseDecideJobName(
				toDecideJobName({ ...KEY, kind: 'review', at: HEAD_DISPATCH_AT })
			)
		).toEqual({ ...KEY, kind: 'review', at: HEAD_DISPATCH_AT })
	})
	test('reads the decide key under the caller job a reusable workflow adds', () => {
		expect(parseDecideJobName(`review / ${toDecideJobName(KEY)}`)).toEqual(KEY)
	})
	for (const name of [
		RISK_JOB_NAMES.DECIDE,
		`${RISK_JOB_NAMES.DECIDE} converse 0@${'a'.repeat(16)} ${KEY.at} ${KEY.head}`,
		`${RISK_JOB_NAMES.DECIDE} converse 42@bad ${KEY.at} ${KEY.head}`,
		`${RISK_JOB_NAMES.DECIDE} run 42@${'a'.repeat(16)} ${KEY.at} ${KEY.head}`,
		`${RISK_JOB_NAMES.DECIDE} converse 42@${'a'.repeat(16)} yesterday ${KEY.head}`,
		`${RISK_JOB_NAMES.DECIDE} converse 42@${'a'.repeat(16)} ${KEY.at} bbbbbbb`,
		`${toDecideJobName(KEY)} trailing`,
		// A dispatch from anything but the sweep, the bridge's included, carries no key.
		`${RISK_JOB_NAMES.DECIDE} ${KEY.kind} ${KEY.id}@${KEY.digest} ${KEY.at} ${KEY.head}`,
		`${RISK_JOB_NAMES.DECIDE} bridge ${KEY.kind} ${KEY.id}@${KEY.digest} ${KEY.at} ${KEY.head}`,
	])
		test(`rejects an invalid decide name ${name}`, () => {
			expect(parseDecideJobName(name)).toBeUndefined()
		})
	test('matches a fixed job name alone or under its caller job only', () => {
		expect(isJobNamed(RISK_JOB_NAMES.RATING, RISK_JOB_NAMES.RATING)).toBe(true)
		expect(
			isJobNamed(`review / ${RISK_JOB_NAMES.RATING}`, RISK_JOB_NAMES.RATING)
		).toBe(true)
		expect(
			isJobNamed(`${RISK_JOB_NAMES.RATING} extra`, RISK_JOB_NAMES.RATING)
		).toBe(false)
		expect(isJobNamed('unlabel', RISK_JOB_NAMES.RATING)).toBe(false)
	})
	test('dispatch inputs carry the key the decide job names', () => {
		expect(toDecideJobName(KEY)).toBe(
			`${RISK_JOB_NAMES.DECIDE} sweep converse 42@${KEY.digest} ${KEY.at} ${KEY.head}`
		)
		expect(toDispatchInputs(17, KEY)).toEqual({
			source: 'sweep',
			number: '17',
			kind: 'converse',
			comment: '42',
			version: KEY.digest,
			edited: KEY.at,
			head: KEY.head,
		})
	})
	for (const conclusion of ['cancelled', 'failure', 'skipped', 'success', null])
		test(`repeat after ${conclusion}`, () => {
			expect(
				getDispatchVerdict({
					key: KEY,
					checksPass: true,
					maxRuns: 5,
					onHead: 0,
					runs: [{ key: KEY, conclusion }],
				})
			).toBe(
				conclusion === null
					? 'in-flight'
					: conclusion === 'failure' || conclusion === 'skipped'
						? 'blocked'
						: 'dispatch'
			)
		})
	for (const change of [
		{ digest: 'c'.repeat(16) },
		{ at: '2026-01-01T12:00:01Z' },
		{ id: 43 },
		{ head: 'd'.repeat(40) },
	])
		test(`another dispatch key is eligible ${JSON.stringify(change)}`, () => {
			expect(
				getDispatchVerdict({
					key: { ...KEY, ...change },
					checksPass: true,
					maxRuns: 5,
					onHead: 0,
					runs: [{ key: KEY, conclusion: 'failure' }],
				})
			).toBe('dispatch')
		})
	test('counts every own dispatch on this head and refuses at the limit', () => {
		const runs = [
			{ key: KEY, conclusion: 'cancelled' },
			{ key: { ...KEY, head: 'd'.repeat(40) }, conclusion: 'success' },
		]
		expect(countHeadDispatches(runs, KEY.head)).toBe(1)
		expect(
			getDispatchVerdict({
				key: KEY,
				runs,
				checksPass: true,
				maxRuns: 1,
				onHead: countHeadDispatches(runs, KEY.head),
			})
		).toBe('run-limit')
		expect(
			getDispatchVerdict({
				key: KEY,
				runs: [],
				checksPass: false,
				maxRuns: 5,
				onHead: 0,
			})
		).toBe('checks-failed')
	})
	test('the run limit counts the dispatches on the head since it arrived, not only the runs listed', () => {
		expect(
			getDispatchVerdict({
				key: KEY,
				runs: [],
				checksPass: true,
				maxRuns: 2,
				onHead: 2,
			})
		).toBe('run-limit')
	})
	test('a failed decide job whose group job failed blocks at once', () => {
		expect(
			getDispatchVerdict({
				key: KEY,
				runs: [{ key: KEY, conclusion: 'failure', decide: 'failure' }],
				checksPass: true,
				maxRuns: 5,
				onHead: 1,
			})
		).toBe('blocked')
	})
	for (const decides of [
		['failure'],
		['failure', 'failure'],
		['success'],
		['failure', 'success'],
	] as const)
		test(`a failed decide job allows one repeat only: decide ${decides.join(',')}`, () => {
			const runs = decides.map(decide => ({
				key: KEY,
				conclusion: 'skipped',
				decide,
			}))
			expect(
				getDispatchVerdict({
					key: KEY,
					runs,
					checksPass: true,
					maxRuns: 5,
					onHead: runs.length,
				})
			).toBe(
				decides.length === 1 && decides[0] === 'failure'
					? 'dispatch'
					: 'blocked'
			)
		})
})
