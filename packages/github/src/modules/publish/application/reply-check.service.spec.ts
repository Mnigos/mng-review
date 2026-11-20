import { layer } from '@effect/vitest'
import { GitError, GitService } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import {
	ACCEPTED_DECISION,
	decidedReply,
	pendingBotThread,
} from '../../../shared/mocks/thread-reply-test.helper'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import { ReplyCheckService, ReplyCheckServiceLive } from './reply-check.service'

const RESOLVED = {
	action: 'resolved',
	reason: 'The guard fixes it.',
} as const satisfies ThreadReplyDecision

/** A changed finding file, an untouched file and a binary file at bound commits. */
function setup() {
	const repo = createRepo()
	repo.write('src/store.ts', 'inherited policy\nold behavior\nkept guard\n')
	repo.write('src/untouched.ts', 'unchanged guard\n')
	repo.write('data.bin', 'binary\0content\n')
	const base = repo.commit()
	repo.write('src/store.ts', 'inherited policy\nnew behavior\nkept guard\n')
	const head = repo.commit()
	const git = gitLayer(repo.root)
	return {
		repo,
		base,
		head,
		git,
		checker: ReplyCheckServiceLive.pipe(Layer.provide(git)),
	}
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })('ReplyCheckService', test => {
	test.effect(
		'drops resolved when only another file changed after the thread commit',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decidedReply(RESOLVED)],
							threads: [
								pendingBotThread({
									commit: fixture.base,
									path: 'src/untouched.ts',
								}),
							],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
	)
	test.effect(
		'keeps resolved when a later commit touched the finding file',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const decision = decidedReply(RESOLVED)
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decision],
							threads: [pendingBotThread({ commit: fixture.base })],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([decision])
			})
	)
	test.effect(
		'counts a rename away from the finding path as a later touch',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.repo.git('mv', 'src/untouched.ts', 'src/renamed.ts')
				const head = fixture.repo.commit()
				const decision = decidedReply(RESOLVED)
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decision],
							threads: [
								pendingBotThread({
									commit: fixture.base,
									path: 'src/untouched.ts',
								}),
							],
							head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([decision])
			})
	)
	test.effect(
		'counts a touch even when a later commit restores the original file',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.repo.write(
					'src/store.ts',
					`${fixture.repo.git('show', `${fixture.base}:src/store.ts`)}\n`
				)
				const head = fixture.repo.commit()
				expect(
					fixture.repo.git('diff', fixture.base, head, '--', 'src/store.ts')
				).toBe('')
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decidedReply(RESOLVED)],
							threads: [pendingBotThread({ commit: fixture.base })],
							head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([decidedReply(RESOLVED)])
			})
	)
	test.effect(
		'drops resolved for an existing commit on a divergent branch',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.repo.git('checkout', '-b', 'divergent', fixture.base)
				fixture.repo.write('src/store.ts', 'divergent behavior\n')
				const divergent = fixture.repo.commit()
				expect(fixture.repo.git('merge-base', fixture.head, divergent)).toBe(
					fixture.base
				)
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decidedReply(RESOLVED)],
							threads: [pendingBotThread({ commit: divergent })],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
	)
	for (const commit of [
		undefined,
		'HEAD',
		'a'.repeat(7),
		'0'.repeat(40),
	] as const)
		test.effect(
			`drops resolved with an absent, non-full or missing commit: ${commit}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					expect(
						yield* ReplyCheckService.use(service =>
							service.check({
								decisions: [decidedReply(RESOLVED)],
								threads: [pendingBotThread({ commit })],
								head: fixture.head,
								change: undefined,
							})
						).pipe(Effect.provide(fixture.checker))
					).toEqual([])
				})
		)
	test.effect(
		'drops resolved when the thread is already at the bound head',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decidedReply(RESOLVED)],
							threads: [pendingBotThread({ commit: fixture.head })],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
	)
	for (const evidence of [
		'src/store.ts:2',
		'data.bin:1',
		'missing.ts:1',
		'src/store.ts:4',
		'../store.ts:1',
	])
		test.effect(`drops accepted citing invalid code: ${evidence}`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const change = yield* GitService.use(git =>
					git.readChange(fixture.base, fixture.head)
				).pipe(Effect.provide(fixture.git))
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [
								decidedReply({ ...ACCEPTED_DECISION, evidence: [evidence] }),
							],
							threads: [pendingBotThread()],
							head: fixture.head,
							change,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
		)
	test.effect(
		'keeps accepted with only passing entries in their original order',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const change = yield* GitService.use(git =>
					git.readChange(fixture.base, fixture.head)
				).pipe(Effect.provide(fixture.git))
				const decision = decidedReply({
					...ACCEPTED_DECISION,
					evidence: [
						'src/store.ts:2',
						'src/store.ts:1',
						'data.bin:1',
						'missing.ts:1',
						'src/store.ts:4',
						'src/store.ts:3',
					],
				})
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decision],
							threads: [pendingBotThread()],
							head: fixture.head,
							change,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([
					{
						...decision,
						decision: {
							...decision.decision,
							evidence: ['src/store.ts:1', 'src/store.ts:3'],
						},
					},
				])
			})
	)
	test.effect(
		'drops accepted when publishing could not read the bound change',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [decidedReply(ACCEPTED_DECISION)],
							threads: [pendingBotThread()],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
	)
	for (const action of ['resolved', 'accepted'] as const)
		test.effect(`drops ${action} when its thread is absent`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions: [
								decidedReply(
									action === 'resolved' ? RESOLVED : ACCEPTED_DECISION
								),
							],
							threads: [],
							head: fixture.head,
							change: undefined,
						})
					).pipe(Effect.provide(fixture.checker))
				).toEqual([])
			})
		)
	for (const command of ['merge-base', 'log', 'ls-tree', 'diff'] as const)
		for (const failure of ['exit', 'effect'] as const)
			test.effect(
				`drops a closing decision when ${command} fails through ${failure}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const git = yield* GitService.pipe(Effect.provide(fixture.git))
						const change = yield* git.readChange(fixture.base, fixture.head)
						const execSpy = vi.fn((args: readonly string[]) =>
							args[0] === command
								? failure === 'exit'
									? Effect.succeed({
											exitCode: 128,
											stdout: '',
											stderr: 'fixture failure',
										})
									: Effect.fail(
											new GitError({
												args,
												exitCode: -1,
												stderr: 'fixture failure',
											})
										)
								: git.exec(args)
						)
						const checker = ReplyCheckServiceLive.pipe(
							Layer.provide(
								Layer.succeed(GitService, { ...git, exec: execSpy })
							)
						)
						expect(
							yield* ReplyCheckService.use(service =>
								service.check({
									decisions: [
										decidedReply(
											command === 'merge-base' || command === 'log'
												? RESOLVED
												: { ...ACCEPTED_DECISION, evidence: ['src/store.ts:1'] }
										),
									],
									threads: [pendingBotThread({ commit: fixture.base })],
									head: fixture.head,
									change,
								})
							).pipe(Effect.provide(checker))
						).toEqual([])
						expect(
							execSpy.mock.calls.some(([args]) => args[0] === command)
						).toBeTruthy()
					})
			)
	test.effect(
		'passes every non-closing action unchanged without reading git',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const git = yield* GitService.pipe(Effect.provide(fixture.git))
				const execSpy = vi.fn(git.exec)
				const readFileAtSpy = vi.fn(git.readFileAt)
				const decisions = [
					decidedReply({ action: 'seen' }),
					...(['still-found', 'disputed', 'needs-owner'] as const).map(action =>
						decidedReply({ action, reason: 'Needs another look.' })
					),
				]
				const checker = ReplyCheckServiceLive.pipe(
					Layer.provide(
						Layer.succeed(GitService, {
							...git,
							exec: execSpy,
							readFileAt: readFileAtSpy,
						})
					)
				)
				expect(
					yield* ReplyCheckService.use(service =>
						service.check({
							decisions,
							threads: [],
							head: 'missing',
							change: undefined,
						})
					).pipe(Effect.provide(checker))
				).toEqual(decisions)
				expect(execSpy).not.toHaveBeenCalled()
				expect(readFileAtSpy).not.toHaveBeenCalled()
			})
	)
})
