import type { InitNote } from '@mng-review/domain'
import type { InitReport } from '@mng-review/engine'

const STATUS_WIDTH = 'overwritten'.length
const NOTE_KIND_WIDTH = 'dropped'.length
/** The command to run after `init`. */
export const INIT_NEXT_STEP =
	'Next: edit the files, then run `mng-review plan --base main` to see which agents would run.'

/** One note line: its kind, the Macroscope file and what happened. */
function toNoteLine(note: InitNote): string {
	return `  ${note.kind.padEnd(NOTE_KIND_WIDTH)}  ${note.source}: ${note.detail}`
}

/** The kind of each imported agent and why, so the user can correct it. */
function toAgentLines({ agents }: InitReport): string[] {
	if (agents.length === 0) return []
	const width = Math.max(...agents.map(agent => agent.name.length))
	return [
		'',
		'Agent kinds (guessed; change `kind:` in the agent file if one is wrong):',
		...agents.map(
			agent => `  ${agent.name.padEnd(width)}  ${agent.kind}  ${agent.reason}`
		),
	]
}

/**
 * What `init` wrote, the kind of each imported agent, the next step and, last, every field it
 * dropped, changed or guessed.
 */
export function formatInitText(report: InitReport): string {
	const header =
		report.source === 'macroscope'
			? `Wrote .mng/ from .macroscope/ in ${report.root}:`
			: `Wrote a starter .mng/ in ${report.root}:`
	return [
		header,
		...report.files.map(
			file => `  ${file.status.padEnd(STATUS_WIDTH)}  ${file.path}`
		),
		...toAgentLines(report),
		'',
		INIT_NEXT_STEP,
		...(report.notes.length === 0
			? []
			: [
					'',
					`Dropped, changed or guessed (${report.notes.length}):`,
					...report.notes.map(toNoteLine),
				]),
	].join('\n')
}
