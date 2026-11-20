import { isOwnerAccess } from './command-access.helper'

describe('isOwnerAccess', () => {
	test.each([
		['admin', 'none', [], true],
		['maintain', 'read', ['CONTRIBUTOR'], true],
		['write', 'read', ['contributor'], true],
		['write', 'write', [], false],
		['read', 'admin', ['contributor'], false],
		['triage', 'write', ['contributor'], false],
		['custom', 'write', ['CONTRIBUTOR'], true],
		['custom', 'admin', ['contributor'], true],
		['custom', 'admin', [], false],
		['custom', 'read', ['contributor'], false],
	] as const)(
		'%s with permission %s and allow %j grants owner access=%s',
		(role, permission, allow, granted) => {
			expect(
				isOwnerAccess('Contributor', { role_name: role, permission }, allow)
			).toBe(granted)
		}
	)
})
