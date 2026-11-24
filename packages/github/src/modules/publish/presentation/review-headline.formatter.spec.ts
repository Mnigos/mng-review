import { COVERED_REVIEW } from '../../../shared/mocks/publish-test.helper'
import type { ReviewEvidence } from '../domain/review-event.helper'
import {
	formatReviewHeadline,
	toBodyWithHeadline,
	toBodyWithoutHeadline,
} from './review-headline.formatter'

interface HeadlineCase {
	readonly name: string
	readonly evidence: ReviewEvidence
	readonly expected: string
}

const REPLIED = {
	kind: 'reply',
	verdict: 'ready',
	openBugs: 0,
	current: true,
	onHead: true,
	failed: false,
	authored: false,
} as const satisfies ReviewEvidence

/** Every reason a run gives for not approving, under a comment. */
const CASES = [
	{
		name: 'offline',
		evidence: { kind: 'offline', authored: false },
		expected:
			'the reviewer was offline, so this run judged nothing and kept the earlier state.',
	},
	{
		name: 'a thread waiting for the owner',
		evidence: { ...COVERED_REVIEW, verdict: 'needs owner' },
		expected: 'a thread waits for the owner to decide.',
	},
	{
		name: 'open bugs',
		evidence: { ...COVERED_REVIEW, verdict: 'needs fixes', openBugs: 3 },
		expected:
			'3 confirmed bug(s) at or above the severity floor are still open.',
	},
	{
		name: 'a moved head',
		evidence: { ...COVERED_REVIEW, onHead: false },
		expected:
			'the pull request moved to another commit, or could not be read again, while this run worked, so the earlier state stands.',
	},
	{
		name: 'a reply-only run whose head moved',
		evidence: { ...REPLIED, current: false, onHead: false },
		expected:
			'the pull request moved to another commit, or could not be read again, while this run worked, so the earlier state stands.',
	},
	{
		name: 'a reply-only run after a full review with a failed run',
		evidence: { ...REPLIED, failed: true },
		expected:
			'a run of the last full review failed or did not report, so the earlier state stands.',
	},
	{
		name: 'threads that could not be read again',
		evidence: { ...COVERED_REVIEW, failed: true, gap: { kind: 'threads' } },
		expected:
			"the bot's threads could not be read again before this review was written.",
	},
	{
		name: 'a reply-only run on another head',
		evidence: { ...REPLIED, onHead: false },
		expected:
			'replies were answered on a commit the last full review did not cover, so the earlier state stands.',
	},
	{
		name: 'a reply-only run',
		evidence: REPLIED,
		expected:
			'a run that only answers replies never approves; the next full review can.',
	},
	{
		name: 'one agent',
		evidence: { ...COVERED_REVIEW, full: false },
		expected:
			'this run reviewed with one agent only, so the earlier state stands.',
	},
	{
		name: 'no main reviewer',
		evidence: { ...COVERED_REVIEW, gap: { kind: 'no-reviewer' } },
		expected:
			'the main reviewer did not run (a quick review skips it), so no run read the whole change.',
	},
	{
		name: 'several gaps in one sentence',
		evidence: {
			...COVERED_REVIEW,
			gap: { kind: 'no-reviewer' },
			more: [{ kind: 'skipped', tooLarge: 1, binary: 0, files: 2 }],
		},
		expected:
			'the main reviewer did not run (a quick review skips it), so no run read the whole change; 1 of 2 changed files were too large to review.',
	},
	{
		name: 'too large files',
		evidence: {
			...COVERED_REVIEW,
			gap: { kind: 'skipped', tooLarge: 3, binary: 0, files: 41 },
		},
		expected: '3 of 41 changed files were too large to review.',
	},
	{
		name: 'binary files',
		evidence: {
			...COVERED_REVIEW,
			gap: { kind: 'skipped', tooLarge: 0, binary: 2, files: 41 },
		},
		expected: '2 of 41 changed files are binary and were not reviewed.',
	},
	{
		name: 'too large and binary files',
		evidence: {
			...COVERED_REVIEW,
			gap: { kind: 'skipped', tooLarge: 1, binary: 2, files: 41 },
		},
		expected: '3 of 41 changed files were too large or binary to review.',
	},
	{
		name: 'a budget stop',
		evidence: { ...COVERED_REVIEW, gap: { kind: 'budget' } },
		expected:
			'the review stopped at its token budget before reading every changed file.',
	},
	{
		name: 'failed runs',
		evidence: {
			...COVERED_REVIEW,
			gap: { kind: 'failed', failed: 2, runs: 5 },
		},
		expected: '2 of 5 review run(s) failed or did not report.',
	},
	{
		name: 'unread files',
		evidence: { ...COVERED_REVIEW, gap: { kind: 'unread', unread: 4 } },
		expected: 'the main reviewer answered without reading 4 changed file(s).',
	},
	{
		name: 'findings that never block',
		evidence: { ...COVERED_REVIEW, gap: { kind: 'findings', findings: 2 } },
		expected:
			'only findings that do not block remain (2: unverified, below the severity floor, or nits), and the bot approves only a change it has nothing left to flag.',
	},
	{
		name: 'an unfinished run with no gap',
		evidence: { ...COVERED_REVIEW, verdict: 'incomplete' },
		expected: 'the review did not finish.',
	},
	{
		name: 'a pull request the bot opened',
		evidence: { ...COVERED_REVIEW, authored: true },
		expected:
			'the bot opened this pull request, and GitHub gives the author of a pull request no review state.',
	},
	{
		name: 'preview mode',
		evidence: { ...COVERED_REVIEW, approval: 'preview' },
		expected: 'approvals are turned off (`verdict.mode: preview`).',
	},
	{
		name: 'the job token',
		evidence: { ...COVERED_REVIEW, approval: 'token' },
		expected:
			'the job token cannot approve; only a GitHub App identity approves.',
	},
	{
		name: 'a draft, closed or merged pull request',
		evidence: { ...COVERED_REVIEW, open: false },
		expected: 'the pull request is a draft, closed or merged.',
	},
	{
		name: 'unread files in preview mode',
		evidence: {
			...COVERED_REVIEW,
			approval: 'preview',
			gap: { kind: 'unread', unread: 4 },
		},
		expected:
			'the main reviewer answered without reading 4 changed file(s); approvals are turned off (`verdict.mode: preview`).',
	},
	{
		name: 'findings in token mode on a pull request the bot opened',
		evidence: {
			...COVERED_REVIEW,
			approval: 'token',
			authored: true,
			gap: { kind: 'findings', findings: 1 },
		},
		expected:
			'only findings that do not block remain (1: unverified, below the severity floor, or nits), and the bot approves only a change it has nothing left to flag; the bot opened this pull request, and GitHub gives the author of a pull request no review state; the job token cannot approve; only a GitHub App identity approves.',
	},
	{
		name: 'a draft pull request in preview mode',
		evidence: { ...COVERED_REVIEW, open: false, approval: 'preview' },
		expected:
			'the pull request is a draft, closed or merged; approvals are turned off (`verdict.mode: preview`).',
	},
] as const satisfies readonly HeadlineCase[]

test.each(CASES)('a comment says why it did not approve: $name', scenario => {
	expect(
		formatReviewHeadline({
			event: 'COMMENT',
			evidence: scenario.evidence,
			keep: false,
		})
	).toBe(`**Comment.** Not approved: ${scenario.expected}`)
})

test('a change request opens with its state and the blocking reason', () => {
	expect(
		formatReviewHeadline({
			event: 'REQUEST_CHANGES',
			evidence: { ...COVERED_REVIEW, verdict: 'needs fixes', openBugs: 1 },
			keep: false,
		})
	).toBe(
		'**Changes requested.** Not approved: 1 confirmed bug(s) at or above the severity floor are still open.'
	)
})

test('a fresh approval opens with its state and no reason', () => {
	expect(
		formatReviewHeadline({
			event: 'APPROVE',
			evidence: COVERED_REVIEW,
			keep: false,
		})
	).toBe(
		'**Approved.** A full review of this commit read every changed file and kept no finding.'
	)
})

test('a kept approval names the earlier review and why this run left it', () => {
	expect(
		formatReviewHeadline({
			event: 'APPROVE',
			evidence: { ...COVERED_REVIEW, full: false },
			keep: true,
		})
	).toBe(
		'**Approved.** An earlier full review of this commit approved it, and this run left that state: this run reviewed with one agent only, so the earlier state stands.'
	)
})

test('each write replaces the headline an earlier write put first', () => {
	const first = toBodyWithHeadline(
		'**Verdict: ready**\nDetails',
		'**Comment.** Old.'
	)
	const second = toBodyWithHeadline(first, '**Approved.** New.')
	expect(second).toBe('**Approved.** New.\n\n**Verdict: ready**\nDetails')
	expect(toBodyWithoutHeadline(second)).toBe('**Verdict: ready**\nDetails')
	expect(toBodyWithoutHeadline('**Verdict: ready**')).toBe('**Verdict: ready**')
})

describe('reading caps and unknown heads', () => {
	test('a run over its cap names the cap in the reason', () => {
		expect(
			formatReviewHeadline({
				event: 'COMMENT',
				evidence: {
					...COVERED_REVIEW,
					gap: { kind: 'cap', cap: 1_400_000 },
					more: [{ kind: 'unread', unread: 4 }],
				},
				keep: false,
			})
		).toBe(
			'**Comment.** Not approved: reading every changed file needs more than the 1,400,000 tokens `limits.tokens_per_run` lets the finders plan, so the review read only what fit; the main reviewer answered without reading 4 changed file(s).'
		)
	})
	for (const evidence of [
		{ ...COVERED_REVIEW, onHead: false, headUnknown: true, open: true },
		{ ...REPLIED, current: false, onHead: false, headUnknown: true },
	] as const)
		test(`a ${evidence.kind} run whose last read of the pull request failed says so`, () => {
			expect(
				formatReviewHeadline({ event: 'COMMENT', evidence, keep: false })
			).toBe(
				'**Comment.** Not approved: the pull request could not be read again before the review, so the earlier state stands.'
			)
		})
})

describe('a failed head read under a blocking verdict', () => {
	for (const verdict of ['needs fixes', 'needs owner'] as const)
		test(`${verdict} still says the pull request could not be read again`, () => {
			expect(
				formatReviewHeadline({
					event: 'COMMENT',
					evidence: {
						...COVERED_REVIEW,
						verdict,
						openBugs: 2,
						onHead: false,
						headUnknown: true,
					},
					keep: true,
				})
			).toBe(
				'**Comment.** Not approved: the pull request could not be read again before the review, so the earlier state stands.'
			)
		})
})
