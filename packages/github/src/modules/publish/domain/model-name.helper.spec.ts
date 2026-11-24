import { toModelName } from './model-name.helper'

describe('toModelName', () => {
	test.each([
		['claude-opus-5-5', 'Opus 5.5'],
		['claude-sonnet-5.5', 'Sonnet 5.5'],
		['claude-5-5-opus', 'Opus 5.5'],
		['claude-5.5-sonnet', 'Sonnet 5.5'],
		['claude-haiku-5', 'Haiku 5'],
		['claude-5-haiku', 'Haiku 5'],
		['claude-opus-5-5-20261101', 'Opus 5.5'],
		['claude-5-opus-20261101', 'Opus 5'],
		['provider/claude-opus-5-5', 'Opus 5.5'],
		['provider/path/CLAUDE-5-5-OPUS', 'Opus 5.5'],
		['gpt-6.1-sol', 'GPT-6.1 Sol'],
		['provider/gpt-6.1', 'GPT-6.1'],
		['gemini-4-carbon', 'Gemini 4 Carbon'],
		['provider/gemini-4-flash-lite', 'Gemini 4 Flash Lite'],
		['Unknown/Custom-MODEL', 'Unknown/Custom-MODEL'],
		['', ''],
	])('formats %s as %s', (id, name) => {
		expect(toModelName(id)).toBe(name)
	})
	test('regression: a date suffix after a major-only Claude version is not a minor version', () => {
		expect(toModelName('claude-opus-5-20261101')).toBe('Opus 5')
	})
})
