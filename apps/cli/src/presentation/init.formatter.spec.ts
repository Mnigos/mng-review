import type { InitReport } from '@mng-review/engine'
import { formatInitText, INIT_NEXT_STEP } from './init.formatter'

const STARTER_REPORT = {
	root: '/example/repository',
	source: 'starter',
	files: [
		{ path: '.mng/review.yml', status: 'created' },
		{ path: '.mng/CONTEXT.md', status: 'overwritten' },
		{ path: '.mng/MEMORY.md', status: 'created' },
	],
	agents: [],
	notes: [],
} as const satisfies InitReport

test('lists every starter file with status and the next step', () => {
	const text = formatInitText(STARTER_REPORT)
	expect(text).toContain(`Wrote a starter .mng/ in ${STARTER_REPORT.root}:`)
	for (const file of STARTER_REPORT.files)
		expect(text).toContain(
			`  ${file.status.padEnd('overwritten'.length)}  ${file.path}`
		)
	expect(text.endsWith(INIT_NEXT_STEP)).toBeTruthy()
	expect(text).not.toContain('Agent kinds')
	expect(text).not.toContain('Dropped, changed or guessed')
})

test('lists imported agent kinds and reasons and puts every note last in order', () => {
	const report = {
		...STARTER_REPORT,
		source: 'macroscope',
		agents: [
			{ name: 'billing', kind: 'bug', reason: 'No convention words.' },
			{
				name: 'conventions',
				kind: 'nit',
				reason: 'Title mentions conventions.',
			},
		],
		notes: [
			{
				kind: 'dropped',
				source: '.macroscope/check-run-agents/billing.md',
				detail: 'model has no equivalent',
			},
			{
				kind: 'changed',
				source: '.macroscope/check-run-agents/billing.md',
				detail: 'code_object became full_diff',
			},
			{
				kind: 'guessed',
				source: '.macroscope/check-run-agents/conventions.md',
				detail: 'kind: nit',
			},
		],
	} as const satisfies InitReport
	const text = formatInitText(report)
	expect(text).toContain(`Wrote .mng/ from .macroscope/ in ${report.root}:`)
	for (const agent of report.agents)
		expect(text).toContain(
			`${agent.name.padEnd('conventions'.length)}  ${agent.kind}  ${agent.reason}`
		)
	const notesStart = text.indexOf(
		`Dropped, changed or guessed (${report.notes.length}):`
	)
	expect(notesStart).toBeGreaterThan(text.indexOf(INIT_NEXT_STEP))
	expect(text.indexOf('Agent kinds')).toBeLessThan(text.indexOf(INIT_NEXT_STEP))
	expect(text.slice(notesStart).split('\n').slice(1)).toEqual(
		report.notes.map(
			note =>
				`  ${note.kind.padEnd('dropped'.length)}  ${note.source}: ${note.detail}`
		)
	)
})
