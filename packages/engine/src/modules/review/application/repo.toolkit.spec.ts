import { Predicate, Result, Schema } from 'effect'
import { Tool } from 'effect/ai'
import { REPO_TOOLS } from './repo.toolkit'
import { ReportFindingsTool } from './report-findings.tool'
import { ReportVerdictTool } from './report-verdict.tool'

const UNSUPPORTED_KEYWORDS = [
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'minLength',
	'maxLength',
	'minItems',
	'maxItems',
	'format',
] as const
const SCHEMA_MAPS = [
	'$defs',
	'definitions',
	'properties',
	'patternProperties',
	'dependentSchemas',
] as const
const SCHEMA_CHILDREN = [
	'allOf',
	'anyOf',
	'oneOf',
	'prefixItems',
	'items',
	'additionalItems',
	'additionalProperties',
	'unevaluatedProperties',
	'unevaluatedItems',
	'contains',
	'propertyNames',
	'not',
	'if',
	'then',
	'else',
	'contentSchema',
] as const

/** Walks schema nodes while treating property names and annotation payloads as data. */
function unsupportedKeywords(schema: unknown, path = '$'): string[] {
	if (Array.isArray(schema))
		return schema.flatMap((child, index) =>
			unsupportedKeywords(child, `${path}[${index}]`)
		)
	if (!Predicate.isObject(schema)) return []
	return Object.entries(schema).flatMap(([key, value]) => {
		const location = `${path}.${key}`
		if (UNSUPPORTED_KEYWORDS.some(keyword => keyword === key)) return [location]
		if (
			SCHEMA_MAPS.some(keyword => keyword === key) &&
			Predicate.isObject(value)
		)
			return Object.entries(value).flatMap(([name, child]) =>
				unsupportedKeywords(child, `${location}.${name}`)
			)
		return SCHEMA_CHILDREN.some(keyword => keyword === key)
			? unsupportedKeywords(value, location)
			: []
	})
}

describe('provider tool schemas', () => {
	for (const tool of [...REPO_TOOLS, ReportFindingsTool, ReportVerdictTool])
		test(`${tool.name} omits unsupported schema keywords at every depth`, () => {
			expect(unsupportedKeywords(Tool.getJsonSchema(tool))).toEqual([])
		})
	test('report_verdict exposes an optional premise in parameters and the provider schema', () => {
		const parameters = {
			verdict: 'unverified',
			severity: 'high',
			reason: 'The callback reaches the filter.',
			evidence: ['src/filter.ts:2'],
		} as const
		const decode = Schema.decodeUnknownResult(
			ReportVerdictTool.parametersSchema
		)
		expect(Result.isSuccess(decode(parameters))).toBeTruthy()
		expect(
			decode({ ...parameters, premise: 'Example Router passes a URL.' })
		).toEqual(
			Result.succeed({ ...parameters, premise: 'Example Router passes a URL.' })
		)
		const schema = Tool.getJsonSchema(ReportVerdictTool)
		expect(schema).toMatchObject({
			properties: { premise: { type: 'string' } },
		})
		expect(schema.required).not.toContain('premise')
	})
	test('schema walking permits keyword-shaped property names and annotation data', () => {
		expect(
			unsupportedKeywords({
				type: 'object',
				properties: Object.fromEntries(
					UNSUPPORTED_KEYWORDS.map(name => [name, { type: 'string' }])
				),
				default: { minimum: 1 },
				examples: [{ format: 'text' }],
				description: 'minimum maximum format',
			})
		).toEqual([])
	})
	test('schema walking finds constraints inside definitions, properties and combinators', () => {
		for (const keyword of UNSUPPORTED_KEYWORDS)
			expect(
				unsupportedKeywords({
					$defs: {
						format: {
							properties: { minimum: { anyOf: [{ items: { [keyword]: 1 } }] } },
						},
					},
				})
			).toEqual([`$.$defs.format.properties.minimum.anyOf[0].items.${keyword}`])
	})
})
