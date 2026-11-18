import { layer } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { splitCappedLines } from './capped-lines.util'

layer(Layer.empty)('splitCappedLines', test => {
	test.effect(
		'splits across chunks and keeps a last line without a newline',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Stream.runCollect(
						splitCappedLines(Stream.make('a\nb', 'c\r\n\nd'), 10)
					)
				).toEqual(['a', 'bc\r', '', 'd'])
			})
	)
	test.effect('a final newline adds no empty line', () =>
		Effect.gen(function* () {
			expect(
				yield* Stream.runCollect(splitCappedLines(Stream.make('a\n'), 10))
			).toEqual(['a'])
		})
	)
	test.effect('cuts a line that spans many chunks to the cap', () =>
		Effect.gen(function* () {
			expect(
				yield* Stream.runCollect(
					splitCappedLines(Stream.make('abc', 'def', 'ghi\nxy', 'z123'), 4)
				)
			).toEqual(['abcd', 'xyz1'])
		})
	)
})
