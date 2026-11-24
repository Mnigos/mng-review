import { agentReport, report } from '../../../shared/mocks/publish-test.helper'
import { toRunNotes } from './summary-agents.formatter'

describe('toRunNotes unread files', () => {
	const reviewed = report()
	test('names each file the main reviewer did not read whole, once, with why', () => {
		const notes = toRunNotes(
			{
				...reviewed,
				agents: [
					{
						...agentReport(),
						unread: 2,
						unreadFiles: [
							{ path: 'src/a.ts', reason: 'untouched' },
							{ path: 'src/b.ts', reason: 'partial' },
						],
					},
					{
						...agentReport(),
						unread: 2,
						unreadFiles: [
							{ path: 'src/b.ts', reason: 'untouched' },
							{ path: 'src/c.ts', reason: 'deletions' },
						],
					},
				],
			},
			10
		)
		expect(notes).toContain(
			'Not read whole: `src/a.ts` (not read), `src/b.ts` (diff read in part), `src/c.ts` (read with read_file, which cannot show deleted lines)'
		)
	})
	test('lists at most the limit and counts the rest', () => {
		const notes = toRunNotes(
			{
				...reviewed,
				agents: [
					{
						...agentReport(),
						unread: 3,
						unreadFiles: ['a', 'b', 'c'].map(name => ({
							path: `src/${name}.ts`,
							reason: 'untouched' as const,
						})),
					},
				],
			},
			1
		)
		expect(notes).toContain('Not read whole: `src/a.ts` (not read), and 2 more')
	})
	test('says nothing when every file was read', () => {
		expect(
			toRunNotes(reviewed, 10).some(line => line.startsWith('Not read whole'))
		).toBe(false)
	})
})
