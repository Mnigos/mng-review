import type { AgentInput } from '../agents/agent-front-matter.schema'
import {
	AGENT_NAME_PATTERN,
	AGENTS_DIR,
	RESERVED_AGENT_NAMES,
} from '../agents/agent.constants'
import { toYamlText, type YamlMapping } from '../utils/yaml-text.util'
import {
	MACROSCOPE_BUDGET_KEY_PATTERN,
	MACROSCOPE_INPUTS,
	MACROSCOPE_MODEL_KEYS,
	NIT_TOPIC_PATTERN,
	RENAMED_AGENT_SUFFIX,
} from './init.constants'
import type {
	AgentKindChoice,
	InitNote,
	MacroscopeFile,
	RulesFile,
} from './init.types'
import type { MacroscopeDocument } from './macroscope-file.parser'
import type { MacroscopeAgent } from './macroscope-file.schema'

/** One converted Macroscope agent: its `.mng/agents/` file, the kind chosen and what changed. */
export interface ImportedAgent {
	readonly file: RulesFile
	readonly choice: AgentKindChoice
	readonly notes: readonly InitNote[]
}

/** What an imported agent is built from. */
export interface AgentImportInput {
	readonly file: MacroscopeFile
	readonly document: MacroscopeDocument<MacroscopeAgent>
	/** Agent names already taken by earlier files. */
	readonly taken: ReadonlySet<string>
	/** `requires` of the correctness file, added to every agent's `needs`. */
	readonly sharedNeeds: readonly string[]
}

/** The file name without its directory and `.md`. */
function getFileStem(path: string): string {
	return (path.split('/').at(-1) ?? '').replace(/\.md$/iu, '')
}

/** Agent name from a Macroscope file name: lowercase, dashes for anything else. */
function toBaseName(path: string): string {
	return getFileStem(path)
		.toLowerCase()
		.replaceAll(/[^a-z0-9-]+/gu, '-')
		.replaceAll(/^-+|-+$/gu, '')
}

/**
 * A valid agent name for a Macroscope file: its file name when that is a valid, unreserved and
 * unused agent name, otherwise one with a suffix.
 */
export function toAgentName(path: string, taken: ReadonlySet<string>): string {
	const base = toBaseName(path)
	const valid =
		AGENT_NAME_PATTERN.test(base) &&
		!RESERVED_AGENT_NAMES.some(reserved => reserved === base)
	const name = valid ? base : `${base || 'imported'}-${RENAMED_AGENT_SUFFIX}`
	if (!taken.has(name)) return name
	const free = Array.from({ length: taken.size + 1 }, (_, index) => index + 2)
		.map(index => `${name}-${index}`)
		.find(candidate => !taken.has(candidate))
	return free ?? `${name}-${taken.size + 2}`
}

/**
 * `nit` when the title or the body is about conventions, style or hygiene, otherwise `bug`, with the
 * word that decided it.
 */
export function getAgentKind(
	name: string,
	title: string | undefined,
	body: string
): AgentKindChoice {
	const inTitle = title === undefined ? null : NIT_TOPIC_PATTERN.exec(title)
	if (inTitle)
		return { name, kind: 'nit', reason: `title mentions "${inTitle[0]}"` }
	const inBody = NIT_TOPIC_PATTERN.exec(body)
	if (inBody)
		return { name, kind: 'nit', reason: `instructions mention "${inBody[0]}"` }
	return {
		name,
		kind: 'bug',
		reason: 'no mention of conventions, style or hygiene',
	}
}

/** The agent `input` for a Macroscope `input` value, or `undefined` for a value with no match. */
function getAgentInput(input: string): AgentInput | undefined {
	return Object.entries(MACROSCOPE_INPUTS).find(([key]) => key === input)?.[1]
}

/** The `input` key of the front matter and the note when it is not imported as it was. */
function toInputPart(
	input: string | undefined,
	source: string
): readonly [YamlMapping, readonly InitNote[]] {
	if (input === undefined) return [{}, []]
	const mapped = getAgentInput(input)
	if (mapped === undefined)
		return [
			{},
			[
				{
					kind: 'dropped',
					source,
					detail: `input: ${input} has no equivalent; the agent reads the incremental diff`,
				},
			],
		]
	if (input === 'code_object')
		return [
			{ input: mapped },
			[
				{
					kind: 'changed',
					source,
					detail:
						'input: code_object became full_diff; agents have no per-object input',
				},
			],
		]
	return [{ input: mapped }, []]
}

/** Notes for the front matter keys `init` does not import. */
function toDroppedKeyNotes(
	keys: readonly string[],
	source: string
): InitNote[] {
	const model = keys.filter(key =>
		MACROSCOPE_MODEL_KEYS.some(modelKey => modelKey === key)
	)
	const budget = keys.filter(key => MACROSCOPE_BUDGET_KEY_PATTERN.test(key))
	const other = keys.filter(
		key => !(model.includes(key) || budget.includes(key))
	)
	return [
		...(model.length === 0
			? []
			: [
					{
						kind: 'dropped' as const,
						source,
						detail: `${model.join(', ')}: the agent runs on models.agents from review.yml`,
					},
				]),
		...(budget.length === 0
			? []
			: [
					{
						kind: 'dropped' as const,
						source,
						detail: `${budget.join(', ')}: runs and tokens are capped by limits in review.yml`,
					},
				]),
		...(other.length === 0
			? []
			: [
					{
						kind: 'dropped' as const,
						source,
						detail: `${other.join(', ')}: no equivalent`,
					},
				]),
	]
}

/** A list key of the front matter, left out when the list is empty. */
function toListPart(key: string, values: readonly string[] = []): YamlMapping {
	return values.length === 0 ? {} : { [key]: values }
}

/**
 * Converts one `.macroscope/check-run-agents/*.md` file into a `.mng/agents/*.md` file. The body
 * and its `@/path` imports are kept as they are.
 */
export function toImportedAgent(input: AgentImportInput): ImportedAgent {
	const { file, document, taken, sharedNeeds } = input
	const { fields, otherKeys, body } = document
	const name = toAgentName(file.path, taken)
	const choice = getAgentKind(name, fields.title, body)
	const [inputPart, inputNotes] = toInputPart(fields.input, file.path)
	const needs = [...new Set([...(fields.requires ?? []), ...sharedNeeds])]
	const when = {
		...toListPart('paths', fields.include),
		...toListPart('exclude', fields.exclude),
		...toListPart('labels', fields.labels),
		...toListPart('authors', fields.authors),
		...toListPart('targets', fields.targets),
	}
	const frontMatter: YamlMapping = {
		...(fields.title === undefined ? {} : { title: fields.title }),
		kind: choice.kind,
		...(Object.keys(when).length === 0 ? {} : { when }),
		...inputPart,
		...toListPart('needs', needs),
	}
	const renamed = getFileStem(file.path) !== name
	return {
		file: {
			path: `${AGENTS_DIR}/${name}.md`,
			text: `---\n${toYamlText(frontMatter)}---\n${body}`,
		},
		choice,
		notes: [
			...(renamed
				? [
						{
							kind: 'changed' as const,
							source: file.path,
							detail: `written as ${name}.md; agent names are lowercase, unique and not a built-in role`,
						},
					]
				: []),
			...inputNotes,
			...toDroppedKeyNotes(otherKeys, file.path),
			{
				kind: 'guessed',
				source: file.path,
				detail: `kind: ${choice.kind} (${choice.reason})`,
			},
		],
	}
}
