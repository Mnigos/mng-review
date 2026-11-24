import { Option, Schema } from 'effect'
import {
	type RiskDescription,
	riskDescriptionSchema,
} from './risk-description.schema'
import {
	RISK_DESCRIPTION_PATTERN,
	RISK_DESCRIPTION_VERSION,
} from './risk.constants'

const decodeDescription = Schema.decodeUnknownOption(riskDescriptionSchema)

/**
 * The rating a status description holds, or `undefined` for any text that is not exactly the one
 * form: no other version, no extra space, no trailing newline, no upper-case hex.
 */
export function parseRiskDescription(
	text: string
): RiskDescription | undefined {
	const match = RISK_DESCRIPTION_PATTERN.exec(text)
	if (!match) return undefined
	const [, pr, level, floor, base, rules, nonce] = match
	return Option.getOrUndefined(
		decodeDescription({
			pr: Number(pr),
			level,
			floor: floor === 'yes',
			base,
			rules,
			nonce,
		})
	)
}

/** The description text of a rating, the one form `parseRiskDescription` reads back. */
export function toRiskDescription(description: RiskDescription): string {
	const { pr, level, floor, base, rules, nonce } = description
	return `${RISK_DESCRIPTION_VERSION} pr=${pr} ${level} floor=${floor ? 'yes' : '-'} base=${base} rules=${rules} nonce=${nonce}`
}
