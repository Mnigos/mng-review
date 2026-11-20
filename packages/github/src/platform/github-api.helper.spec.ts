import { isDeclined } from './github-api.helper'
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
	for (const status of [200, 399, 500, 503, 599, undefined])
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
