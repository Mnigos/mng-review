import { Effect, Layer } from 'effect'
import { RiskRunService } from '../../application/risk-run.service'

/**
 * The rating as a run with `risk.enabled` off sees it: every publish runs without a rating block
 * and the report says `off`. Specs of the rating itself use the real service.
 */
export const RiskRunOffLayer = Layer.succeed(RiskRunService, {
	rateFull: (_gate, _input, publish) =>
		publish(undefined).pipe(
			Effect.map(value => ({ value, risk: { status: 'off' } as const }))
		),
	rateThread: () => Effect.succeed({ status: 'off' } as const),
})
