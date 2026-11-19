import { Tool } from 'effect/ai'
import { routerAnswerSchema } from '../domain/router-answer.schema'

/** The one tool the router must call: agents to add and the risk level. */
export const RouteTool = Tool.make('route', {
	description: 'Report the agents to add and the risk signals of the change.',
	parameters: routerAnswerSchema,
})
