/**
 * A time in milliseconds as GitHub writes times, ISO 8601 in whole seconds (`2026-01-01T12:30:00Z`),
 * so it orders as text against GitHub's own times. The fraction is dropped, never rounded up.
 */
export function toGitHubTime(millis: number): string {
	return `${new Date(millis).toISOString().slice(0, 19)}Z`
}
