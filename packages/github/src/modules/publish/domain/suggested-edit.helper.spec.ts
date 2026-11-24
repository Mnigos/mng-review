import type { ConfirmedEdit, KeptFinding } from '@mng-review/domain'
import { bug } from '../../../shared/mocks/publish-test.helper'
import {
	getConfirmedEdit,
	isEditOnHeadLine,
	toWithoutEdit,
} from './suggested-edit.helper'

const HEAD = 'a'.repeat(40)
const HEAD_TEXT = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
const EDIT = {
	commit: HEAD,
	line: bug().line,
	original: `line ${bug().line}`,
	replacement: 'fixed()',
} as const satisfies ConfirmedEdit

/** A confirmed finding carrying `edit`. */
function confirmed(edit: ConfirmedEdit = EDIT): KeptFinding {
	return bug({
		validation: {
			status: 'confirmed',
			severity: 'high',
			reason: 'Confirmed.',
			evidence: [],
			model: 'model',
			edit,
		},
	})
}

describe('isEditOnHeadLine', () => {
	test('holds when the line at the head reads the original text exactly', () => {
		expect(
			isEditOnHeadLine({
				finding: confirmed(),
				head: HEAD,
				headText: HEAD_TEXT,
			})
		).toBeTruthy()
	})
	test.each([
		[
			'another head',
			{ finding: confirmed({ ...EDIT, commit: 'b'.repeat(40) }) },
		],
		['a moved finding', { finding: { ...confirmed(), line: EDIT.line + 1 } }],
		[
			'a moved finding with matching metadata',
			{
				finding: {
					...confirmed({ ...EDIT, line: EDIT.line + 1 }),
					line: EDIT.line + 1,
				},
			},
		],
		[
			'a wrong original',
			{ finding: confirmed({ ...EDIT, original: 'other' }) },
		],
		[
			'an original with trailing whitespace',
			{ finding: confirmed({ ...EDIT, original: `${EDIT.original} ` }) },
		],
		['a failed read', { headText: undefined }],
		['a line past the end', { headText: 'line 1\n' }],
		['no edit', { finding: bug() }],
	] as const)('fails for %s', (_name, overrides) => {
		expect(
			isEditOnHeadLine({
				finding: confirmed(),
				head: HEAD,
				headText: HEAD_TEXT,
				...overrides,
			})
		).toBeFalsy()
	})
})

describe('toWithoutEdit', () => {
	test('drops only the edit of a confirmed finding', () => {
		const stripped = toWithoutEdit(confirmed())
		expect(getConfirmedEdit(stripped)).toBeUndefined()
		expect(stripped.validation).toMatchObject({ status: 'confirmed' })
		expect({ ...stripped, validation: undefined }).toEqual({
			...confirmed(),
			validation: undefined,
		})
	})
	test('keeps a finding without an edit as it is', () => {
		const finding = bug()
		expect(toWithoutEdit(finding)).toBe(finding)
	})
})
