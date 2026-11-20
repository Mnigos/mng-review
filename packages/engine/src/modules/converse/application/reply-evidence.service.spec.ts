import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'
import { pr } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { MAX_EVIDENCE_CHECKED } from '../domain/reply.constants'
import {
	ReplyEvidenceService,
	ReplyEvidenceServiceLive,
} from './reply-evidence.service'

/** Head, base-only, binary, attribute-marked and symlink evidence in a real repository. */
function setup() {
	const repo = createRepo()
	repo.write('src/store.ts', 'inherited policy\nold behavior\nkept guard\n')
	repo.write('src/deleted.ts', 'base policy\nbase guard\n')
	repo.write('data.bin', 'binary\0content\n')
	repo.write('.gitattributes', 'opaque.txt -diff\n')
	repo.write('opaque.txt', 'old policy\nkept guard\n')
	symlinkSync('src/store.ts', join(repo.root, 'link.ts'))
	const base = repo.commit()
	repo.write(
		'src/store.ts',
		'inherited policy\nnew behavior\nkept guard\nadded policy\n'
	)
	repo.write('opaque.txt', 'new policy\nkept guard\n')
	repo.git('rm', 'src/deleted.ts')
	const head = repo.commit()
	const git = gitLayer(repo.root)
	return {
		repo,
		base,
		head,
		git,
		evidence: ReplyEvidenceServiceLive.pipe(Layer.provide(git)),
	}
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ReplyEvidenceService.checkInCode',
	test => {
		for (const entry of [
			'src/store.ts:2',
			'src/store.ts:4',
			'src/store.ts:1-2',
			'data.bin:1',
			'link.ts:1',
			'opaque.txt:2',
			'missing.ts:1',
			'src/store.ts:5',
			'src/deleted.ts:3',
			'../src/store.ts:1',
			'not a citation',
		])
			test.effect(
				`rejects evidence outside unchanged repository code: ${entry}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const change = yield* GitService.use(git =>
							git.readChange(fixture.base, fixture.head)
						).pipe(Effect.provide(fixture.git))
						expect(
							yield* ReplyEvidenceService.use(service =>
								service.checkInCode([entry], change)
							).pipe(Effect.provide(fixture.evidence))
						).toEqual([])
					})
			)
		test.effect(
			'accepts unchanged head lines without a classifier read ledger',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const change = yield* GitService.use(git =>
						git.readChange(fixture.base, fixture.head)
					).pipe(Effect.provide(fixture.git))
					const entries = ['src/store.ts:1', 'src/store.ts:3']
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.checkInCode(entries, change)
						).pipe(Effect.provide(fixture.evidence))
					).toEqual(entries)
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.check(
								{
									claim: 'intentional',
									reason: 'The guard is inherited.',
									evidence: entries,
								},
								{ change, pr: pr() },
								new Set()
							)
						).pipe(Effect.provide(fixture.evidence))
					).toEqual([])
				})
		)
		test.effect(
			'reads a file missing at the head from the merge base rather than the bound base tip',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.repo.git('checkout', '-b', 'base-tip', fixture.base)
					fixture.repo.write('src/deleted.ts', 'different base tip\n')
					const baseTip = fixture.repo.commit()
					const change = yield* GitService.use(git =>
						git.readChange(baseTip, fixture.head)
					).pipe(Effect.provide(fixture.git))
					expect(change.mergeBase).toBe(fixture.base)
					expect(change.base.commit).toBe(baseTip)
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.checkInCode(['src/deleted.ts:1-2'], change)
						).pipe(Effect.provide(fixture.evidence))
					).toEqual(['src/deleted.ts:1-2'])
				})
		)
		test.effect(
			'filters mixed entries without dropping valid evidence or changing its order',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const change = yield* GitService.use(git =>
						git.readChange(fixture.base, fixture.head)
					).pipe(Effect.provide(fixture.git))
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.checkInCode(
								[
									'missing.ts:1',
									'src/store.ts:3',
									'src/store.ts:2',
									'src/deleted.ts:1-2',
									'data.bin:1',
									'src/store.ts:1',
								],
								change
							)
						).pipe(Effect.provide(fixture.evidence))
					).toEqual(['src/store.ts:3', 'src/deleted.ts:1-2', 'src/store.ts:1'])
				})
		)
		test.effect(
			'keeps inherited lines across a rename and drops newly written lines',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.repo.git('mv', 'src/store.ts', 'src/renamed.ts')
					const head = fixture.repo.commit()
					const change = yield* GitService.use(git =>
						git.readChange(fixture.base, head)
					).pipe(Effect.provide(fixture.git))
					expect(change.files).toContainEqual(
						expect.objectContaining({
							path: 'src/renamed.ts',
							status: 'renamed',
							oldPath: 'src/store.ts',
						})
					)
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.checkInCode(
								['src/renamed.ts:1', 'src/renamed.ts:2'],
								change
							)
						).pipe(Effect.provide(fixture.evidence))
					).toEqual(['src/renamed.ts:1'])
				})
		)
		test.effect('checks at most MAX_EVIDENCE_CHECKED entries', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const change = yield* GitService.use(git =>
					git.readChange(fixture.base, fixture.head)
				).pipe(Effect.provide(fixture.git))
				const entries = Array.from(
					{ length: MAX_EVIDENCE_CHECKED + 1 },
					() => 'src/store.ts:1'
				)
				expect(
					yield* ReplyEvidenceService.use(service =>
						service.checkInCode(entries, change)
					).pipe(Effect.provide(fixture.evidence))
				).toEqual(entries.slice(0, MAX_EVIDENCE_CHECKED))
			})
		)
		for (const command of ['ls-tree', 'diff'] as const)
			test.effect(
				`propagates a ${command} failure instead of accepting evidence`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						const git = yield* GitService.pipe(Effect.provide(fixture.git))
						const change = yield* git.readChange(fixture.base, fixture.head)
						const execSpy = vi.fn((args: readonly string[]) =>
							args[0] === command
								? Effect.succeed({
										exitCode: 128,
										stdout: '',
										stderr: 'fixture failure',
									})
								: git.exec(args)
						)
						const evidence = ReplyEvidenceServiceLive.pipe(
							Layer.provide(
								Layer.succeed(GitService, { ...git, exec: execSpy })
							)
						)
						expect(
							yield* ReplyEvidenceService.use(service =>
								service.checkInCode(['src/store.ts:1'], change)
							).pipe(Effect.provide(evidence), Effect.flip)
						).toMatchObject({ _tag: 'GitError', exitCode: 128 })
					})
			)
		test.effect(
			'propagates a blob read failure instead of accepting evidence',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const git = yield* GitService.pipe(Effect.provide(fixture.git))
					const change = yield* git.readChange(fixture.base, fixture.head)
					const readFileAtSpy = vi.fn(() =>
						Effect.fail(
							new GitError({
								args: ['show'],
								exitCode: -1,
								stderr: 'fixture failure',
							})
						)
					)
					const evidence = ReplyEvidenceServiceLive.pipe(
						Layer.provide(
							Layer.succeed(GitService, { ...git, readFileAt: readFileAtSpy })
						)
					)
					expect(
						yield* ReplyEvidenceService.use(service =>
							service.checkInCode(['src/store.ts:1'], change)
						).pipe(Effect.provide(evidence), Effect.flip)
					).toMatchObject({ _tag: 'GitError', exitCode: -1 })
				})
		)
	}
)
