import {
	getLineCount,
	isEvidenceInCode,
	type EvidenceFile,
} from './reply-evidence.helper'
import type { EvidenceRef } from './reply-evidence.parser'

const REF = {
	path: 'src/money.ts',
	lines: { start: 2, end: 3 },
} as const satisfies EvidenceRef

describe('getLineCount', () => {
	test.each([
		['', 0],
		['one', 1],
		['one\n', 1],
		['one\ntwo', 2],
		['one\ntwo\n', 2],
		['\n', 1],
		['one\n\n', 2],
	] as const)('counts %j as %s lines', (text, count) => {
		expect(getLineCount(text)).toBe(count)
	})
})

describe('isEvidenceInCode', () => {
	test.each([
		[
			'unchanged head lines',
			{ headLines: 5, baseLines: 5, added: [{ start: 4, end: 5 }] },
			true,
		],
		[
			'an added line also present by number at base',
			{ headLines: 5, baseLines: 5, added: [{ start: 2, end: 2 }] },
			false,
		],
		[
			'an added line at the end of the evidence range',
			{ headLines: 5, baseLines: 5, added: [{ start: 3, end: 4 }] },
			false,
		],
		[
			'base-only lines past the head end of a file at head',
			{ headLines: 1, baseLines: 5, added: [] },
			false,
		],
		[
			'a file deleted at head',
			{ headLines: undefined, baseLines: 5, added: [] },
			true,
		],
		[
			'a missing file',
			{ headLines: undefined, baseLines: undefined, added: [] },
			false,
		],
		[
			'lines past both file ends',
			{ headLines: 1, baseLines: 2, added: [] },
			false,
		],
		[
			'a new file with added evidence',
			{ headLines: 5, baseLines: undefined, added: [{ start: 1, end: 5 }] },
			false,
		],
	] as const satisfies readonly (readonly [string, EvidenceFile, boolean])[])(
		'%s',
		(_name, file, expected) => {
			expect(isEvidenceInCode(REF, file)).toBe(expected)
		}
	)
	test('refuses added head code in a range that also extends into base-only lines', () => {
		expect(
			isEvidenceInCode(REF, {
				headLines: 2,
				baseLines: 5,
				added: [{ start: 2, end: 2 }],
			})
		).toBe(false)
	})
})
