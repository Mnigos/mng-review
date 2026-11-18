/** Any http or https address, up to whitespace or a closing bracket or quote. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/giu
export const REDACTED = '[redacted]'

/**
 * Removes every secret (keys, addresses) and every http(s) URL from text that may reach an error
 * message or a log. Longer secrets are replaced first, so a secret that contains another goes whole.
 */
export function redactText(text: string, secrets: readonly string[]): string {
	const withoutSecrets = secrets
		.filter(secret => secret.length > 0)
		.toSorted((a, b) => b.length - a.length)
		.reduce((out, secret) => out.replaceAll(secret, REDACTED), text)
	return withoutSecrets.replace(URL_PATTERN, REDACTED)
}
