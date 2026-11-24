import { toOutputPage } from './output-part.helper'
import { MAX_TOOL_OUTPUT_CHARS } from './review.constants'

describe('toOutputPage', () => {
	test.each(['', 'short diff', 'x'.repeat(MAX_TOOL_OUTPUT_CHARS)])(
		'keeps output within the cap unchanged',
		text => {
			expect(toOutputPage(text).output).toBe(text)
		}
	)
	test.each([
		-3,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])('clamps offset %s to zero', offset => {
		expect(toOutputPage('first\nsecond\n', offset).output).toBe(
			'first\nsecond\n'
		)
	})
	test('floors fractional offsets and reads from that character', () => {
		expect(toOutputPage('first\nsecond\n', 6.9).output).toBe('second\n')
	})
	test.each([5, 50])('reports no more output at offset %i', offset => {
		expect(toOutputPage('hello', offset).output).toBe(
			'(no more output; it ends at offset 5)'
		)
	})
	test('following the named offsets reads every character exactly once at line boundaries', () => {
		const text = Array.from(
			{ length: 1000 },
			(_, index) => `+line ${index}: ${'x'.repeat(73)}\n`
		).join('')
		const parts: string[] = []
		for (let offset = 0; offset < text.length;) {
			const part = toOutputPage(text, offset).output
			expect(part.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS)
			const marker = /\n\[more: call diff again with offset=(\d+)\]$/u.exec(
				part
			)
			const content = marker ? part.slice(0, marker.index) : part
			expect(content.endsWith('\n')).toBeTruthy()
			expect(content).toBe(text.slice(offset, offset + content.length))
			parts.push(content)
			const next = marker ? Number(marker[1]) : text.length
			expect(next).toBe(offset + content.length)
			expect(next).toBeGreaterThan(offset)
			offset = next
		}
		expect(parts.length).toBeGreaterThan(2)
		expect(parts.join('')).toBe(text)
	})
	test('a line longer than the cap still advances within the cap', () => {
		const text = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2)
		const part = toOutputPage(text).output
		const marker = /\n\[more: call diff again with offset=(\d+)\]$/u.exec(part)
		expect(marker).not.toBeNull()
		expect(part.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS)
		expect(Number(marker?.[1])).toBeGreaterThan(0)
		expect(part.slice(0, marker?.index)).toBe(
			text.slice(0, Number(marker?.[1]))
		)
	})
})
