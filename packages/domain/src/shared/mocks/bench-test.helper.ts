import type { ExpectedFinding } from '../../bench/bench-file.schema'
import { toBenchFinding } from '../../bench/bench.helper'
import type { BenchFinding } from '../../bench/bench.types'
import { finding } from './domain-test.helper'

/** A benchmark bug with independently allocated description and a default unvalidated status. */
export function benchFinding(
	overrides: Partial<BenchFinding> = {}
): BenchFinding {
	return {
		...toBenchFinding({ ...finding(overrides), placement: 'inline' }),
		...overrides,
	}
}

/** An expected bug entry whose position and description can be varied independently. */
export function expectedFinding(
	overrides: Partial<ExpectedFinding> = {}
): ExpectedFinding {
	return {
		id: 'duplicate-charge',
		path: 'src/billing/charge.ts',
		line: 81,
		label: 'real',
		summary: 'A retry charges twice.',
		...overrides,
	}
}
