import { isDeclined, isRateLimited } from './github-api.helper'
import { GitHubApiError } from './github.errors'

describe('isDeclined', () => {
	for (const status of [400, 403, 404, 499])
		test(`HTTP ${status} declines the request`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'refused',
						status,
					})
				)
			).toBe(true)
		})
	for (const status of [200, 399, 429, 500, 503, 599, undefined])
		test(`HTTP ${status} does not decline the request`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'no refusal',
						...(status === undefined ? {} : { status }),
					})
				)
			).toBe(false)
		})
	test('GraphQL errors decline the request without an HTTP error status', () => {
		expect(
			isDeclined(
				new GitHubApiError({
					operation: 'minimize',
					reason: 'not minimizable',
					graphqlErrors: true,
					graphqlTypes: ['FORBIDDEN'],
				})
			)
		).toBe(true)
	})
	test('graphqlErrors false without a status does not decline the request', () => {
		expect(
			isDeclined(
				new GitHubApiError({
					operation: 'minimize',
					reason: 'no answer',
					graphqlErrors: false,
				})
			)
		).toBe(false)
	})
})

describe('GraphQL refusal types', () => {
	for (const graphqlTypes of [
		['FORBIDDEN'],
		['NOT_FOUND'],
		['UNPROCESSABLE'],
		['FORBIDDEN', 'NOT_FOUND', 'UNPROCESSABLE'],
	])
		test(`${graphqlTypes.join(', ')} declines the request`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'refused',
						graphqlErrors: true,
						graphqlTypes,
					})
				)
			).toBe(true)
		})
	for (const graphqlTypes of [
		undefined,
		[],
		[null],
		['RATE_LIMITED'],
		['INTERNAL'],
		['FORBIDDEN', 'RATE_LIMITED'],
		['NOT_FOUND', null],
		['UNPROCESSABLE', 'INTERNAL'],
	])
		test(`${JSON.stringify(graphqlTypes)} is not a refusal, even with HTTP 403`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'request failed',
						status: 403,
						graphqlErrors: true,
						...(graphqlTypes === undefined ? {} : { graphqlTypes }),
					})
				)
			).toBe(false)
		})
	for (const details of [
		{ rateLimited: true, reason: 'Request failed' },
		{ reason: 'API rate limit exceeded' },
		{ reason: 'You have exceeded a secondary RATE LIMIT' },
	] as const)
		test(`HTTP 403 with ${JSON.stringify(details)} is not a refusal`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						status: 403,
						...details,
					})
				)
			).toBe(false)
		})
	for (const reason of [
		'You have exceeded a secondary rate limit',
		'Not minimizable; API RATE LIMIT exceeded',
	])
		test(`GraphQL FORBIDDEN with "${reason}" is not a refusal`, () => {
			expect(
				isDeclined(
					new GitHubApiError({
						operation: 'minimize',
						reason,
						graphqlErrors: true,
						graphqlTypes: ['FORBIDDEN'],
					})
				)
			).toBe(false)
		})
})

describe('isRateLimited', () => {
	for (const headers of Array.of<Readonly<Record<string, string>>>(
		{ 'retry-after': '60' },
		{ 'retry-after': '0' },
		{ 'x-ratelimit-remaining': '0' },
		{ 'retry-after': '60', 'x-ratelimit-remaining': '10' }
	))
		test(`${JSON.stringify(headers)} indicates a rate limit`, () => {
			expect(isRateLimited(headers)).toBe(true)
		})
	for (const headers of Array.of<Readonly<Record<string, string>>>(
		{},
		{ 'x-ratelimit-remaining': '1' }
	))
		test(`${JSON.stringify(headers)} does not indicate a rate limit`, () => {
			expect(isRateLimited(headers)).toBe(false)
		})
})
