import type { Severity } from '../config/review-config.schema'

/**
 * What each severity means, by the impact when the trigger happens. Finders rate with it and the
 * validator re-rates with it, so both read the same criteria (`docs/spec.md`, Severity).
 */
export const SEVERITY_CRITERIA = {
	critical:
		'data is lost or corrupted, or a security boundary fails: private data, credentials, money or access reach someone who should not have them',
	high: 'the program crashes, a request or a main flow fails, or users get wrong data, shown to them or stored',
	medium:
		'behaviour a user can see is broken, but the user can recover: retry, reload, undo or take another path',
	low: 'cosmetic, or nothing a user can reach: only logs, metrics or developer tooling change',
} as const satisfies Record<Severity, string>

/** The severity rubric as prompt text, the most severe level first. */
export const SEVERITY_RUBRIC = `Rate severity by what goes wrong when the trigger happens. Pick the highest level whose criterion the impact meets:
- \`critical\`: ${SEVERITY_CRITERIA.critical}.
- \`high\`: ${SEVERITY_CRITERIA.high}.
- \`medium\`: ${SEVERITY_CRITERIA.medium}.
- \`low\`: ${SEVERITY_CRITERIA.low}.
How often the trigger happens does not change the level, and neither does how many users it reaches: a defect that only hits one platform, browser, locale, user setting or assistive technology rates the same as one that hits everyone.`
