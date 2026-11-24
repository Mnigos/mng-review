import type { CommentEdit } from '../../platform/github-risk.schema'

/** The bot that wrote and edited the comment in `EDITED_COMMENT_PAGES`. */
export const COMMENT_EDITS_BOT = 'coderabbitai'

/**
 * Two pages of a real edited conversation comment's `userContentEdits`, read three edits per page
 * from pull request 48 of this repository on 2026-11-24. Only the body and each version's text
 * (`diff`, the whole text after that edit) are replaced, each by its own placeholder; the newest
 * edit's text was the body and has the body's placeholder. GitHub listed the edits newest first,
 * the created version last, and gave the same `totalCount` on both pages.
 */
export const EDITED_COMMENT_PAGES = [
	{
		data: {
			node: {
				body: 'marker',
				userContentEdits: {
					totalCount: 4,
					pageInfo: {
						hasNextPage: true,
						endCursor: 'Y3Vyc29yOnYyOpHPAAAAAW8iFI8=',
					},
					nodes: [
						{
							id: 'UCE_lALOVyWi7M8AAAABqDBpac8AAAABbyU0uQ',
							editedAt: '2026-11-23T23:28:55Z',
							editor: { __typename: 'Bot', login: COMMENT_EDITS_BOT },
							diff: 'marker',
						},
						{
							id: 'UCE_lALOVyWi7M8AAAABqDBpac8AAAABbyIg4g',
							editedAt: '2026-11-23T23:20:31Z',
							editor: { __typename: 'Bot', login: COMMENT_EDITS_BOT },
							diff: 'marker version 3',
						},
						{
							id: 'UCE_lALOVyWi7M8AAAABqDBpac8AAAABbyIUjw',
							editedAt: '2026-11-23T23:20:23Z',
							editor: { __typename: 'Bot', login: COMMENT_EDITS_BOT },
							diff: 'marker version 2',
						},
					],
				},
			},
		},
	},
	{
		data: {
			node: {
				body: 'marker',
				userContentEdits: {
					totalCount: 4,
					pageInfo: {
						hasNextPage: false,
						endCursor: 'Y3Vyc29yOnYyOpHPAAAAAW8iFIY=',
					},
					nodes: [
						{
							id: 'UCE_lALOVyWi7M8AAAABqDBpac8AAAABbyIUhg',
							editedAt: '2026-11-23T23:13:56Z',
							editor: { __typename: 'Bot', login: COMMENT_EDITS_BOT },
							diff: 'marker version 1',
						},
					],
				},
			},
		},
	},
] as const

/** Every edit the pages of `EDITED_COMMENT_PAGES` list, in the order GitHub listed them. */
export function getEditedCommentEdits(): readonly CommentEdit[] {
	return EDITED_COMMENT_PAGES.flatMap(
		(page): readonly CommentEdit[] => page.data.node.userContentEdits.nodes
	)
}
