import { deepMerge } from './deep-merge.util'

describe('deepMerge', () => {
	test('merges objects, replaces arrays/scalars/null, and does not mutate either input', () => {
		const base = {
			nested: { kept: 1, replaced: 2 },
			list: ['a', 'b'],
			scalar: 'a',
			nullable: { x: 1 },
		}
		const override = {
			nested: { replaced: 3, added: true },
			list: ['c'],
			scalar: false,
			nullable: null,
		}
		const before = structuredClone({ base, override })
		expect(deepMerge(base, override)).toEqual({
			nested: { kept: 1, replaced: 3, added: true },
			list: ['c'],
			scalar: false,
			nullable: null,
		})
		expect({ base, override }).toEqual(before)
	})
	test.each([
		[undefined, { x: 1 }],
		[null, null],
		[[1], [1]],
		[false, false],
		['text', 'text'],
		[0, 0],
	])('replaces at the root with %p', (override, expected) => {
		expect(deepMerge({ x: 1 }, override)).toEqual(expected)
	})
	test('undefined leaves existing fields intact', () => {
		expect(deepMerge({ x: 1 }, { x: undefined })).toEqual({ x: 1 })
	})
})

test('adds nested mappings when the base field does not exist', () => {
	expect(deepMerge({}, { nested: { value: 1 } })).toEqual({
		nested: { value: 1 },
	})
})
