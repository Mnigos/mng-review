import { Effect } from 'effect'
import type { ConfigError } from '../config/config.errors'
import {
	CONFIG_PATH,
	CONTEXT_PATH,
	DEFAULT_PRESET_NAME,
	MEMORY_PATH,
} from '../config/review-config.constants'
import { toYamlText, type YamlMapping } from '../utils/yaml-text.util'
import {
	DOC_DIR_PATTERN,
	DOC_FILE_PATTERN,
	MACROSCOPE_CORRECTNESS_PATH,
} from './init.constants'
import type {
	InitNote,
	MacroscopeFile,
	MacroscopeFiles,
	RulesDraft,
	RulesFile,
} from './init.types'
import { type ImportedAgent, toImportedAgent } from './macroscope-agent.helper'
import { parseMacroscopeFile } from './macroscope-file.parser'
import {
	macroscopeAgentSchema,
	macroscopeApprovabilitySchema,
	macroscopeCorrectnessSchema,
} from './macroscope-file.schema'
import { REVIEW_YML_HEADER, STARTER_FILES } from './starter-rules.constants'

/** The parts of `review.yml` and `CONTEXT.md` one Macroscope file gives, and its notes. */
interface ImportedPart {
	readonly riskPaths: readonly string[]
	readonly skipPaths: readonly string[]
	readonly needs: readonly string[]
	readonly context?: string
	readonly notes: readonly InitNote[]
}

const EMPTY_PART = {
	riskPaths: [],
	skipPaths: [],
	needs: [],
	notes: [],
} as const satisfies ImportedPart

/**
 * True for a glob that only covers documentation: a segment such as `docs/`, or a last segment
 * such as `*.md` or `README`.
 */
export function isDocGlob(glob: string): boolean {
	const segments = glob.split('/')
	const last = segments.at(-1) ?? ''
	return (
		segments.slice(0, -1).some(segment => DOC_DIR_PATTERN.test(segment)) ||
		DOC_FILE_PATTERN.test(last) ||
		(DOC_DIR_PATTERN.test(last) && segments.length === 1)
	)
}

/** One note for the front matter keys of a file that `init` does not import. */
function toOtherKeysNotes(keys: readonly string[], source: string): InitNote[] {
	if (keys.length === 0) return []
	return [
		{ kind: 'dropped', source, detail: `${keys.join(', ')}: no equivalent` },
	]
}

/** The starter `CONTEXT.md`. */
function getStarterContext(): string {
	return STARTER_FILES.find(file => file.path === CONTEXT_PATH)?.text ?? ''
}

/** `.macroscope/correctness/correctness.md`: the body is the context, `exclude` skips paths. */
const toCorrectnessPart = Effect.fn('toCorrectnessPart')(function* (
	file: MacroscopeFile
) {
	const { fields, otherKeys, body } = yield* parseMacroscopeFile(
		macroscopeCorrectnessSchema,
		file
	)
	const context = body.trim()
	return {
		riskPaths: [],
		skipPaths: fields.exclude ?? [],
		needs: fields.requires ?? [],
		...(context === '' ? {} : { context: `${context}\n` }),
		notes: [
			...toOtherKeysNotes(otherKeys, file.path),
			...(context === ''
				? [
						{
							kind: 'guessed' as const,
							source: file.path,
							detail: 'the body is empty; CONTEXT.md is the starter template',
						},
					]
				: []),
		],
	} satisfies ImportedPart
})

/**
 * `.macroscope/approvability.md`: `neverApprove` becomes `risk_paths`, documentation globs of
 * `alwaysApprove` become `skip.paths`. The body has no equivalent.
 */
const toApprovabilityPart = Effect.fn('toApprovabilityPart')(function* (
	file: MacroscopeFile
) {
	const { fields, otherKeys, body } = yield* parseMacroscopeFile(
		macroscopeApprovabilitySchema,
		file
	)
	const always = fields.alwaysApprove ?? []
	const leftOut = always.filter(glob => !isDocGlob(glob))
	return {
		riskPaths: fields.neverApprove ?? [],
		skipPaths: always.filter(isDocGlob),
		needs: [],
		notes: [
			...toOtherKeysNotes(otherKeys, file.path),
			...(leftOut.length === 0
				? []
				: [
						{
							kind: 'dropped' as const,
							source: file.path,
							detail: `alwaysApprove ${leftOut.join(', ')}: not documentation, so not skipped`,
						},
					]),
			...(body.trim() === ''
				? []
				: [
						{
							kind: 'dropped' as const,
							source: file.path,
							detail:
								'the body (approval criteria) is not imported; the verdict has no custom criteria',
						},
					]),
		],
	} satisfies ImportedPart
})

/** `review.yml` with the imported `risk_paths` and `skip.paths` over the default preset. */
function toReviewYml(
	riskPaths: readonly string[],
	skipPaths: readonly string[]
): string {
	const config: YamlMapping = {
		extends: DEFAULT_PRESET_NAME,
		...(riskPaths.length === 0 ? {} : { risk_paths: riskPaths }),
		...(skipPaths.length === 0 ? {} : { skip: { paths: skipPaths } }),
	}
	return `${REVIEW_YML_HEADER}${toYamlText(config)}`
}

/** Converts each agent file in order, so a renamed agent never takes a later file's name. */
const toImportedAgents = Effect.fn('toImportedAgents')(function* (
	files: readonly MacroscopeFile[],
	sharedNeeds: readonly string[]
) {
	const agents: ImportedAgent[] = []
	for (const file of files) {
		const document = yield* parseMacroscopeFile(macroscopeAgentSchema, file)
		const taken = new Set(agents.map(agent => agent.choice.name))
		agents.push(toImportedAgent({ file, document, taken, sharedNeeds }))
	}
	return agents
})

/** Unique values in first-seen order. */
function toUnique(values: readonly string[]): string[] {
	return [...new Set(values)]
}

/**
 * Builds `.mng/` from `.macroscope/`: `review.yml`, `CONTEXT.md`, an empty `MEMORY.md` and one agent
 * per check-run agent, with a note for every field that was dropped, changed or guessed.
 */
export function toMacroscopeRules(
	files: MacroscopeFiles
): Effect.Effect<RulesDraft, ConfigError> {
	return Effect.gen(function* () {
		const correctness: ImportedPart = files.correctness
			? yield* toCorrectnessPart(files.correctness)
			: EMPTY_PART
		const approvability: ImportedPart = files.approvability
			? yield* toApprovabilityPart(files.approvability)
			: EMPTY_PART
		const agents = yield* toImportedAgents(files.agents, correctness.needs)
		const ruleFiles: RulesFile[] = [
			{
				path: CONFIG_PATH,
				text: toReviewYml(
					toUnique(approvability.riskPaths),
					toUnique([...correctness.skipPaths, ...approvability.skipPaths])
				),
			},
			{ path: CONTEXT_PATH, text: correctness.context ?? getStarterContext() },
			{ path: MEMORY_PATH, text: '' },
			...agents.map(agent => agent.file),
		]
		return {
			files: ruleFiles,
			agents: agents.map(agent => agent.choice),
			notes: [
				...(files.correctness
					? []
					: [
							{
								kind: 'guessed' as const,
								source: MACROSCOPE_CORRECTNESS_PATH,
								detail: 'not found; CONTEXT.md is the starter template',
							},
						]),
				...correctness.notes,
				...approvability.notes,
				...agents.flatMap(agent => agent.notes),
			],
		}
	})
}
