/** The base permission GitHub reports for each built-in role. */
const BUILT_IN_ROLE_PERMISSION = {
	admin: 'admin',
	maintain: 'write',
	write: 'write',
	triage: 'read',
	read: 'read',
} as const

/** The base permission of a role: a built-in role's own, `read` for a custom role. */
export function getBasePermission(role: string): string {
	return (
		Object.entries(BUILT_IN_ROLE_PERMISSION).find(
			([name]) => name === role
		)?.[1] ?? 'read'
	)
}
