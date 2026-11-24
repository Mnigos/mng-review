import {
	AUTHOR_FIXTURES,
	THREAD_FIXTURES,
	type ThreadFixture,
	COMMAND_FIXTURES,
	DIGEST_FIXTURES,
	FIXTURE_HANDLE,
	hasWriteRole,
	type CommandFixture,
} from '@mng-review/domain'
import { botThread } from '../../../shared/mocks/publish-test.helper'
import { toBodyDigest } from '../../publish/domain/bot-thread.helper'
import { isAnswerableThread } from '../../publish/domain/thread-conversation.helper'
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

test.each<ThreadFixture>(THREAD_FIXTURES)(
	'thread: $name',
	({ state, answered }) => {
		const thread = botThread({
			resolved: state.resolved ?? false,
			closedByBot: state.closedByBot ?? false,
			sentToOwner: state.sentToOwner ?? false,
			marker: { ...botThread().marker, kind: state.kind },
		})
		expect(
			isAnswerableThread(thread, state.waiting ? [thread.id] : [], state.held)
		).toBe(answered)
	}
)
