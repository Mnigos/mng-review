import { Effect, Layer } from 'effect'
import type { PullRequestComment } from '../../platform/github-api.schema'
import { GitHubApiService } from '../../platform/github-api.service'
import type {
	CommentEdit,
	CommentEdits,
} from '../../platform/github-risk.schema'
import type { GitHubApiError } from '../../platform/github.errors'
import type { githubApiFake } from './github-api-fake.helper'
import type { ApiWrite } from './github-api-fake.types'
import { APP_IDENTITY } from './publish-test.helper'

/** The in-memory GitHub the edit log reads and writes. */
type ApiFake = ReturnType<typeof githubApiFake>

/** A person's edit of a conversation comment, after the API writes made before it. */
export interface PersonEdit {
	readonly nodeId: string
	readonly login: string
	readonly text: string
	readonly apiWritesBefore: number
}

/** What a person's edit leaves and who made it. */
export type PersonEditInput = Pick<PersonEdit, 'text' | 'login'>

/** How comment updates behave around the store: who acts first and which answers get lost. */
export interface CommentUpdateHooks {
	/** Run just before the next update stores, like a person's edit landing first. */
	readonly beforeUpdate: (() => void)[]
	/** An update GitHub stores and whose answer is then lost. */
	readonly updateStored: GitHubApiError[]
}

/** The app as GitHub names it among a comment's editors. */
const APP_EDITOR = { __typename: 'Bot', login: APP_IDENTITY.login } as const

/** An edit time `index` minutes into the fixture day, so later edits order later. */
function toEditTime(index: number) {
	const hours = String(Math.floor(index / 60)).padStart(2, '0')
	return `2026-01-01T${hours}:${String(index % 60).padStart(2, '0')}:00Z`
}

/**
 * The edit history GitHub keeps for a comment, newest first: every update the app made and every
 * person's edit in the order they landed, over the created version once the comment is edited.
 * Each edit's text is the whole text it left, so the newest one's is the body.
 */
export function toCommentEdits(
	comment: PullRequestComment | undefined,
	writes: readonly ApiWrite[],
	people: readonly PersonEdit[]
): CommentEdits {
	const updates = writes.flatMap((write, index) =>
		write.method === 'update' && write.id === comment?.databaseId
			? [{ at: index, editor: APP_EDITOR, text: write.body }]
			: []
	)
	const edits = [
		...updates,
		...people
			.filter(edit => edit.nodeId === comment?.id)
			.map(edit => ({
				at: edit.apiWritesBefore - 0.5,
				editor: { __typename: 'User', login: edit.login },
				text: edit.text,
			})),
	].toSorted((first, second) => first.at - second.at)
	const body = comment?.body ?? ''
	if (edits.length === 0) return { body, total: 0, edits: [] }
	const listed = [{ editor: APP_EDITOR, text: '' }, ...edits].map(
		(edit, index): CommentEdit => ({
			id: `edit-${index}`,
			editor: edit.editor,
			editedAt: toEditTime(index),
			diff: edit.text,
		})
	)
	return { body, total: listed.length, edits: listed.toReversed() }
}

/** A person's edit of the risk comment: its text becomes the edit's and its editor the person. */
export function editRiskComment(
	api: ApiFake,
	people: PersonEdit[],
	edit: PersonEditInput
): void {
	const index = api.comments.findIndex(comment =>
		comment.body.includes('mng-review:risk')
	)
	const comment = api.comments[index]
	if (!comment) return
	api.comments[index] = {
		...comment,
		body: edit.text,
		editor: { __typename: 'User', login: edit.login },
	}
	people.push({
		nodeId: comment.id,
		...edit,
		apiWritesBefore: api.writes.length,
	})
}

/** The app becomes the comment's last editor, as on GitHub after its update. */
function markEdited(api: ApiFake, id: number) {
	return Effect.sync(() => {
		const index = api.comments.findIndex(comment => comment.databaseId === id)
		const comment = api.comments[index]
		if (comment) api.comments[index] = { ...comment, editor: APP_EDITOR }
	})
}

/** The fake's comment updates with `hooks` around the store, and the app as the editor after. */
export function commentUpdates(api: ApiFake, hooks: CommentUpdateHooks) {
	return Layer.effect(
		GitHubApiService,
		Effect.gen(function* () {
			const service = yield* GitHubApiService
			return {
				...service,
				updateIssueComment: (id: number, body: string) =>
					Effect.sync(() => hooks.beforeUpdate.shift()?.()).pipe(
						Effect.andThen(service.updateIssueComment(id, body)),
						Effect.andThen(markEdited(api, id)),
						Effect.andThen(() => {
							const lost = hooks.updateStored.shift()
							return lost ? Effect.fail(lost) : Effect.void
						})
					),
			}
		})
	).pipe(Layer.provide(api.api))
}
