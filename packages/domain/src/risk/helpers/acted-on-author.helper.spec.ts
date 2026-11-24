import { AUTHOR_FIXTURES, FIXTURE_OWNED } from '../risk-fixtures.constants'
import { BUILT_IN_ROLES, WRITE_ROLES } from '../risk.constants'
import { hasWriteRole, isActedOnAuthor } from './acted-on-author.helper'

describe('acted-on authors', () => {
	test.each(AUTHOR_FIXTURES)('$name', ({ author, role, actedOn }) => {
		expect(isActedOnAuthor(author, role, FIXTURE_OWNED)).toBe(actedOn)
	})
	test.each([
		'mng-bot',
		'MNG-BOT',
		'mng-bot[bot]',
		'github-actions',
		'GitHub-Actions[bot]',
	])('excludes bot login %s even as a User', login => {
		expect(
			isActedOnAuthor(
				{ login, type: 'User', viaApp: false },
				{ role_name: 'write', permission: 'write' },
				FIXTURE_OWNED
			)
		).toBe(false)
	})
	test('does not exclude people whose names merely start with a bot slug', () => {
		expect(
			isActedOnAuthor(
				{ login: 'mng-bot-helper', type: 'User', viaApp: false },
				{ role_name: 'write', permission: 'write' },
				FIXTURE_OWNED
			)
		).toBe(true)
	})
	test.each(BUILT_IN_ROLES)(
		'judges built-in %s by its role name alone',
		role_name => {
			for (const permission of ['admin', 'write', 'read', 'none'])
				expect(hasWriteRole({ role_name, permission })).toBe(
					WRITE_ROLES.some(role => role === role_name)
				)
		}
	)
})
