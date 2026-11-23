/** `claude-<family>-<major>[-<minor>]`, with an optional date suffix. */
const CLAUDE_FAMILY_FIRST =
	/^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/u
/** `claude-<major>[-<minor>]-<family>`, with an optional date suffix. */
const CLAUDE_VERSION_FIRST =
	/^claude-(\d+)(?:[-.](\d{1,2}))?-([a-z]+)(?:-\d{8})?$/u
/** `gpt-<version>[-<name>…]` and `gemini-<version>[-<name>…]`. */
const VERSIONED_FAMILY = /^(gpt|gemini)-(\d[\w.]*)((?:-[a-z]+)*)$/u
/** How each versioned family is written before its version. */
const FAMILY_NAMES = { gpt: 'GPT-', gemini: 'Gemini ' } as const

/** A word with a capital first letter. */
function toCapitalized(word: string): string {
	return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

/** A Claude version: `5` and `5` become `5.5`. */
function toVersion(major: string, minor: string | undefined): string {
	return minor === undefined ? major : `${major}.${minor}`
}

/**
 * A model id as people know the model: the provider prefix dropped, `claude-opus-5-5` as
 * `Opus 5.5`, `gpt-6.1-sol` as `GPT-6.1 Sol`, `gemini-4-carbon` as `Gemini 4 Carbon`. Any other id
 * stays as it is.
 */
export function toModelName(model: string): string {
	const id = model.slice(model.lastIndexOf('/') + 1).toLowerCase()
	const familyFirst = CLAUDE_FAMILY_FIRST.exec(id)
	if (familyFirst) {
		const [, family = '', major = '', minor] = familyFirst
		return `${toCapitalized(family)} ${toVersion(major, minor)}`
	}
	const versionFirst = CLAUDE_VERSION_FIRST.exec(id)
	if (versionFirst) {
		const [, major = '', minor, family = ''] = versionFirst
		return `${toCapitalized(family)} ${toVersion(major, minor)}`
	}
	const versioned = VERSIONED_FAMILY.exec(id)
	if (!versioned) return model
	const [, family = 'gpt', version = '', rest = ''] = versioned
	const words = rest.split('-').filter(Boolean).map(toCapitalized)
	const prefix = family === 'gemini' ? FAMILY_NAMES.gemini : FAMILY_NAMES.gpt
	return [`${prefix}${version}`, ...words].join(' ')
}
