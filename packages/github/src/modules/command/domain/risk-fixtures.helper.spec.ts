import {
	AUTHOR_FIXTURES,
	COMMAND_FIXTURES,
	DIGEST_FIXTURES,
	FIXTURE_HANDLE,
	hasWriteRole,
	type CommandFixture,
} from '@mng-review/domain'
import { toBodyDigest } from '../../publish/domain/bot-thread.helper'
import { hasWriteAccess } from './command-access.helper'
import { parseMentionCommand } from './mention-command.parser'

describe('shared risk fixtures against the GitHub engine helpers', () => {
	test.each<CommandFixture>(COMMAND_FIXTURES)('command: $name', fixture => {
		if (fixture.place === 'conversation') {
			expect(parseMentionCommand(fixture.body, FIXTURE_HANDLE)).toEqual(
				fixture.command
			)
			return
		}
		expect(fixture.command).toBeUndefined()
		expect(parseMentionCommand(fixture.body, FIXTURE_HANDLE)).toEqual({})
	})
	test.each(DIGEST_FIXTURES)('digest: $name', ({ body, digest }) => {
		expect(toBodyDigest(body).slice(0, 16)).toBe(digest)
	})
	test.each(AUTHOR_FIXTURES)('write role: $name', ({ role }) => {
		expect(hasWriteAccess(role)).toBe(hasWriteRole(role))
	})
})
