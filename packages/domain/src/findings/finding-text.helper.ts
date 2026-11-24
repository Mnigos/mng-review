import { toWordCut } from '../utils/word-cut.util'
import {
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_STEP_CHARS,
	MAX_FINDING_TITLE_CHARS,
} from './finding.constants'
import type { ReportedFinding } from './finding.schema'
import type { ParsedFinding } from './finding.types'

/** A line break and the whitespace around it, which a one-line text turns into one space. */
const LINE_BREAK = /\s*[\r\n\p{Zl}\p{Zp}]+\s*/gu
/** The line ends a trigger's steps are split on. */
const STEP_BREAK = /\r\n|[\n\r]/u

/** Text on one line, cut at a word boundary to `max` characters. */
function toOneLine(text: string, max: number): string {
	return toWordCut(text.replace(LINE_BREAK, ' '), max)
}

/**
 * A finding with its text cut to the limits a comment reads well at: the title and fix on one line,
 * each cut at a word boundary with `…` like the impact and every step of the trigger. The limits
 * in the prompts ask for shorter text; this keeps a finding that runs over, never drops it. A title
 * the cut changed is kept as `uncutTitle` for the fingerprint.
 */
export function toWithinTextLimits(finding: ReportedFinding): ParsedFinding {
	const { suggestion } = finding
	const title = toOneLine(finding.title, MAX_FINDING_TITLE_CHARS)
	return {
		...finding,
		title,
		...(title === finding.title ? {} : { uncutTitle: finding.title }),
		impact: toWordCut(finding.impact, MAX_FINDING_IMPACT_CHARS),
		trigger: finding.trigger
			.split(STEP_BREAK)
			.map(step => toWordCut(step, MAX_FINDING_STEP_CHARS))
			.join('\n'),
		...(suggestion
			? { suggestion: toOneLine(suggestion, MAX_FINDING_FIX_CHARS) }
			: {}),
	}
}
