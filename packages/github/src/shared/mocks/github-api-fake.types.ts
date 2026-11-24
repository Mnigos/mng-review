import type { ReviewCommentInput } from '../../platform/github-api.service'
import type { ReviewInput } from '../../platform/github-review.service'

/** One write the in-memory GitHub recorded, in call order. */
export type ApiWrite =
	| {
			readonly method: 'review'
			readonly pullNumber: number
			readonly input: ReviewInput
	  }
	| {
			readonly method: 'comment'
			readonly pullNumber: number
			readonly input: ReviewCommentInput
	  }
	| {
			readonly method: 'create'
			readonly pullNumber: number
			readonly body: string
	  }
	| { readonly method: 'update'; readonly id: number; readonly body: string }
	| {
			readonly method: 'updateReview'
			readonly id: number
			readonly body: string
	  }
	| {
			readonly method: 'dismissReview'
			readonly id: number
			readonly body: string
	  }
	| { readonly method: 'delete'; readonly id: number }
	| { readonly method: 'minimize'; readonly id: string }
	| { readonly method: 'reply'; readonly id: string; readonly body: string }
	| { readonly method: 'editReply'; readonly id: number; readonly body: string }
	| { readonly method: 'resolve'; readonly id: string }
	| { readonly method: 'unresolve'; readonly id: string }
	| {
			readonly method: 'label' | 'unlabel'
			readonly pullNumber: number
			readonly name: string
	  }
