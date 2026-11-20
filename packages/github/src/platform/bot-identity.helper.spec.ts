import { DEFAULT_PRESET } from '@mng-review/domain'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
} from '../shared/mocks/publish-test.helper'
import {
	GITHUB_ACTIONS_IDENTITY,
	isOwnedBot,
	isOwnedCreator,
	toBotIdentity,
	toOwnedIdentities,
} from './bot-identity.helper'

describe('bot identities', () => {
	test('normalizes both GitHub login forms', () => {
		expect(toBotIdentity('MnG-ReViEw')).toEqual({
			login: 'mng-review',
			restLogin: 'mng-review[bot]',
		})
	})
	test('app mode retains the preset identities and removes case-insensitive duplicates', () => {
		expect(APP_MODE_IDENTITIES).toEqual([APP_IDENTITY, GITHUB_ACTIONS_IDENTITY])
		expect(
			toOwnedIdentities(APP_IDENTITY, [
				...DEFAULT_PRESET.identity.previous,
				'MNG-REVIEW',
				'GITHUB-ACTIONS',
			])
		).toEqual(APP_MODE_IDENTITIES)
	})
	test('dropping previous identities trusts only the current app', () => {
		expect(toOwnedIdentities(APP_IDENTITY, [])).toEqual([APP_IDENTITY])
	})
	test('token mode can retain the app on the way back', () => {
		expect(toOwnedIdentities(GITHUB_ACTIONS_IDENTITY, ['mng-review'])).toEqual([
			GITHUB_ACTIONS_IDENTITY,
			APP_IDENTITY,
		])
	})
	test.each(['mng-review', 'github-actions'])(
		'a User named %s is never owned',
		login => {
			expect(
				isOwnedBot({ __typename: 'User', login }, APP_MODE_IDENTITIES)
			).toBe(false)
			expect(
				isOwnedCreator(
					{ type: 'User', login: `${login}[bot]` },
					APP_MODE_IDENTITIES
				)
			).toBe(false)
		}
	)
	test('rejects missing and unowned actors', () => {
		expect(isOwnedBot(null, APP_MODE_IDENTITIES)).toBe(false)
		expect(
			isOwnedBot({ __typename: 'Bot', login: 'other-app' }, APP_MODE_IDENTITIES)
		).toBe(false)
		expect(
			isOwnedCreator(
				{ type: 'Bot', login: 'other-app[bot]' },
				APP_MODE_IDENTITIES
			)
		).toBe(false)
	})
	test('GraphQL and REST logins compare without case', () => {
		expect(
			isOwnedBot(
				{ __typename: 'Bot', login: 'MNG-REVIEW' },
				APP_MODE_IDENTITIES
			)
		).toBe(true)
		expect(
			isOwnedCreator(
				{ type: 'Bot', login: 'GITHUB-ACTIONS[BOT]' },
				APP_MODE_IDENTITIES
			)
		).toBe(true)
	})
})
