import { Effect, Schema, SchemaGetter } from 'effect'
import {
	nameListSchema,
	positiveIntSchema,
} from '../config/review-config.schema'
import { BENCH_FILE_VERSION, EXPECTED_LABELS } from './bench.constants'

/**
 * `real`, `intentional` or `false`. YAML reads a bare `false` as a boolean, so the boolean is
 * accepted and becomes the label `false`.
 */
export const expectedLabelSchema = Schema.Union([
	Schema.Literals(EXPECTED_LABELS),
	Schema.Literal(false).pipe(
		Schema.decodeTo(Schema.Literal('false'), {
			decode: SchemaGetter.transform(() => 'false' as const),
			encode: SchemaGetter.transform(() => false as const),
		})
	),
])
export type ExpectedLabel = typeof expectedLabelSchema.Type

/** One finding a case is expected to produce, or to avoid when it is `intentional` or `false`. */
export const expectedFindingSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	path: Schema.NonEmptyString,
	line: positiveIntSchema,
	label: expectedLabelSchema,
	summary: Schema.NonEmptyString,
})
export type ExpectedFinding = typeof expectedFindingSchema.Type

/** Entry ids are unique within a case. */
const hasUniqueExpectedIds = Schema.makeFilter(
	(entries: readonly ExpectedFinding[]) =>
		new Set(entries.map(entry => entry.id)).size === entries.length ||
		'expected ids must be unique within a case'
)

/** One recorded change: the merge base, the commit to review and what a review should find. */
export const benchCaseSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	/** Merge base of the change. */
	base: Schema.NonEmptyString,
	/** Commit to review. */
	head: Schema.NonEmptyString,
	/** Pull request labels to simulate. */
	labels: nameListSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
	expected: Schema.Array(expectedFindingSchema).check(hasUniqueExpectedIds),
})
export type BenchCase = typeof benchCaseSchema.Type

/** Case ids are unique in a file. */
const hasUniqueCaseIds = Schema.makeFilter(
	(cases: readonly BenchCase[]) =>
		new Set(cases.map(entry => entry.id)).size === cases.length ||
		'case ids must be unique'
)

/** A benchmark file, version 1 (`docs/spec.md`, Benchmark). */
export const benchFileSchema = Schema.Struct({
	version: Schema.Literal(BENCH_FILE_VERSION),
	cases: Schema.Array(benchCaseSchema).check(hasUniqueCaseIds),
})
export type BenchFile = typeof benchFileSchema.Type
