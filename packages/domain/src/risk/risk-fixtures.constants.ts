import type {
	AuthorFixture,
	CommandFixture,
	DigestFixture,
	ThreadFixture,
} from './risk.types'

/**
 * The fixture table the engine and the merge sweep both run, so they read commands, digests and
 * authors the same way. The sweep cannot import the engine and keeps a copy; change both together.
 */
export const FIXTURE_HANDLE = 'mng-bot'
/** The owned bot slugs the author rows are read against. */
export const FIXTURE_OWNED = ['mng-bot'] as const

/** Command grammar cases: only a conversation comment's own line, read by `parseMentionCommand`. */
export const COMMAND_FIXTURES = [
	{
		name: 'review',
		place: 'conversation',
		body: '@mng-bot review',
		command: {},
	},
	{
		name: 'review deep',
		place: 'conversation',
		body: '@mng-bot review deep',
		command: { depth: 'deep' },
	},
	{
		name: 'review quick',
		place: 'conversation',
		body: '@mng-bot review quick',
		command: { depth: 'quick' },
	},
	{
		name: 'run an agent',
		place: 'conversation',
		body: '@mng-bot run auth',
		command: { agent: 'auth' },
	},
	{
		name: 'mention without case',
		place: 'conversation',
		body: '@MNG-Bot review',
		command: {},
	},
	{
		name: 'trailing spaces',
		place: 'conversation',
		body: '@mng-bot review  ',
		command: {},
	},
	{
		name: 'CRLF line after a paragraph',
		place: 'conversation',
		body: 'thanks\r\n\r\n@mng-bot review\r\n',
		command: {},
	},
	{
		name: 'command on a later line',
		place: 'conversation',
		body: 'looks good\n\n@mng-bot review deep',
		command: { depth: 'deep' },
	},
	{
		name: 'text after an HTML comment',
		place: 'conversation',
		body: '<!-- note --> @mng-bot review',
		command: {},
	},
	{
		name: 'extra word',
		place: 'conversation',
		body: '@mng-bot review deep now',
	},
	{
		name: 'unknown depth',
		place: 'conversation',
		body: '@mng-bot review fast',
	},
	{ name: 'run without agent', place: 'conversation', body: '@mng-bot run' },
	{
		name: 'run with an invalid agent',
		place: 'conversation',
		body: '@mng-bot run -x',
	},
	{
		name: 'mention not first',
		place: 'conversation',
		body: 'please @mng-bot review',
	},
	{
		name: 'another handle',
		place: 'conversation',
		body: '@other-bot review',
	},
	{ name: 'list item', place: 'conversation', body: '- @mng-bot review' },
	{ name: 'quote', place: 'conversation', body: '> @mng-bot review' },
	{
		name: 'paragraph a quote runs on into',
		place: 'conversation',
		body: '> earlier text\n@mng-bot review',
	},
	{
		name: 'quote inside a list item',
		place: 'conversation',
		body: '- > @mng-bot review',
	},
	{
		name: 'backtick fence',
		place: 'conversation',
		body: '```\n@mng-bot review\n```',
	},
	{
		name: 'tilde fence with info',
		place: 'conversation',
		body: '~~~text\n@mng-bot review\n~~~',
	},
	{
		name: 'unclosed fence',
		place: 'conversation',
		body: '```\n@mng-bot review',
	},
	{
		name: 'indented code',
		place: 'conversation',
		body: '    @mng-bot review',
	},
	{
		name: 'tab-indented code',
		place: 'conversation',
		body: '\t@mng-bot review',
	},
	{
		name: 'indented line after text',
		place: 'conversation',
		body: 'some text\n    @mng-bot review',
	},
	{
		name: 'HTML comment',
		place: 'conversation',
		body: '<!-- @mng-bot review -->',
	},
	{
		name: 'HTML comment over lines',
		place: 'conversation',
		body: '<!--\n@mng-bot review\n-->',
	},
	{ name: 'review thread', place: 'review-thread', body: '@mng-bot review' },
	{ name: 'review body', place: 'review-body', body: '@mng-bot review' },
	{ name: 'pull request body', place: 'pr-body', body: '@mng-bot review' },
] as const satisfies readonly CommandFixture[]

/** Digest cases: `toAnswerDigest`, the first 16 hex characters of the sha256 of the whole body. */
export const DIGEST_FIXTURES = [
	{ name: 'empty body', body: '', digest: 'e3b0c44298fc1c14' },
	{
		name: 'reply',
		body: 'fixed in the last push',
		digest: 'ef517d3842754928',
	},
	{
		name: 'reply edited within the same second',
		body: 'fixed in the last push.',
		digest: 'c83f1da4843adf84',
	},
	{ name: 'non-ASCII text', body: 'naïve café ✓', digest: '23888e71341419cd' },
	{
		name: 'CRLF kept as written',
		body: 'line one\r\nline two',
		digest: '8ec4c37982ffc5a8',
	},
	{ name: 'command', body: '@mng-bot review', digest: '9090d84c659d14c9' },
] as const satisfies readonly DigestFixture[]

/** A person with no app in between; rows change one field at a time. */
const PERSON = { login: 'writer', type: 'User', viaApp: false } as const
const WRITE_ROLE = { role_name: 'write', permission: 'write' } as const

/** Acted-on cases: the role table, author types and the bot exclusions. */
export const AUTHOR_FIXTURES = [
	{
		name: 'admin',
		author: PERSON,
		role: { role_name: 'admin', permission: 'admin' },
		actedOn: true,
	},
	{
		name: 'maintain',
		author: PERSON,
		role: { role_name: 'maintain', permission: 'write' },
		actedOn: true,
	},
	{ name: 'write', author: PERSON, role: WRITE_ROLE, actedOn: true },
	{
		name: 'triage',
		author: PERSON,
		role: { role_name: 'triage', permission: 'read' },
		actedOn: false,
	},
	{
		name: 'read',
		author: PERSON,
		role: { role_name: 'read', permission: 'read' },
		actedOn: false,
	},
	{
		name: 'built-in read whatever its permission',
		author: PERSON,
		role: { role_name: 'read', permission: 'write' },
		actedOn: false,
	},
	{
		name: 'custom role on write',
		author: PERSON,
		role: { role_name: 'deployer', permission: 'write' },
		actedOn: true,
	},
	{
		name: 'custom role on admin',
		author: PERSON,
		role: { role_name: 'owner-team', permission: 'admin' },
		actedOn: true,
	},
	{
		name: 'custom role on read',
		author: PERSON,
		role: { role_name: 'auditor', permission: 'read' },
		actedOn: false,
	},
	{
		name: 'no access',
		author: PERSON,
		role: { role_name: '', permission: 'none' },
		actedOn: false,
	},
	{
		name: 'bot type',
		author: { login: 'review-helper[bot]', type: 'Bot', viaApp: false },
		role: WRITE_ROLE,
		actedOn: false,
	},
	{
		name: 'organization type',
		author: { login: 'some-org', type: 'Organization', viaApp: false },
		role: WRITE_ROLE,
		actedOn: false,
	},
	{
		name: 'posted through an app',
		author: { ...PERSON, viaApp: true },
		role: WRITE_ROLE,
		actedOn: false,
	},
	{
		name: 'owned bot login',
		author: { ...PERSON, login: 'MNG-Bot[bot]' },
		role: WRITE_ROLE,
		actedOn: false,
	},
	{
		name: 'job token bot',
		author: { ...PERSON, login: 'github-actions[bot]' },
		role: WRITE_ROLE,
		actedOn: false,
	},
] as const satisfies readonly AuthorFixture[]

/**
 * Thread-state cases: whether the converse answers a reply in the app's thread, read the engine's
 * way (`isAnswerableThread` in the github package) and by the merge sweep's unanswered-comment
 * hold. A resolved thread counts only for the reply a dispatched converse was sent for.
 */
export const THREAD_FIXTURES = [
	{ name: 'open bug', state: { kind: 'bug' }, answered: true },
	{ name: 'open unverified', state: { kind: 'unverified' }, answered: true },
	{ name: 'open nit', state: { kind: 'nit' }, answered: false },
	{
		name: 'resolved on GitHub',
		state: { kind: 'bug', resolved: true },
		answered: false,
	},
	{
		name: 'closed by the bot',
		state: { kind: 'bug', resolved: true, closedByBot: true },
		answered: false,
	},
	{
		name: 'resolved, holding the dispatched reply',
		state: { kind: 'bug', resolved: true, held: true },
		answered: true,
	},
	{
		name: 'closed by the bot, holding the dispatched reply',
		state: { kind: 'bug', resolved: true, closedByBot: true, held: true },
		answered: true,
	},
	{
		name: 'waiting for the owner',
		state: { kind: 'bug', waiting: true },
		answered: false,
	},
	{
		name: 'sent to the owner',
		state: { kind: 'bug', sentToOwner: true },
		answered: false,
	},
] as const satisfies readonly ThreadFixture[]
