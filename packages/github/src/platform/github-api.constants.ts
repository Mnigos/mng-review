import { Duration, Schedule } from 'effect'

export const API_VERSION = '2022-11-28'
export const PAGE_SIZE = 100
/** At most this many pages are read; a pull request with more fails the read instead of being cut. */
export const MAX_PAGES = 20
export const CLIENT_ERROR_STATUS = 400
export const SERVER_ERROR_STATUS = 500
export const TOO_MANY_REQUESTS_STATUS = 429
/** GraphQL error types that mean GitHub read the request and refused it, not that it was throttled. */
export const DECLINED_GRAPHQL_TYPES: ReadonlySet<string> = new Set([
	'FORBIDDEN',
	'NOT_FOUND',
	'UNPROCESSABLE',
])
/** GitHub's message for a primary or secondary rate limit. */
export const RATE_LIMIT_MESSAGE = /rate limit/iu
/** One request, its body included, may take this long; a hung request would hold the job. */
export const REQUEST_TIMEOUT = Duration.seconds(30)
/** Reads are retried twice on a network failure, a timeout or a 5xx; writes never, so nothing is posted twice. */
export const READ_RETRIES = 2
export const READ_RETRY = Schedule.exponential('500 millis')

/** The pull request's review threads with their first and latest comment, oldest first. */
export const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine subjectType
          comments(first: 1) {
            totalCount
            nodes { databaseId body author { __typename login } editor { __typename login } originalCommit { oid } }
          }
          latest: comments(last: 1) {
            nodes { databaseId body author { __typename login } editor { __typename login } originalCommit { oid } }
          }
        }
      }
    }
  }
}`

/** The comments of one review thread, oldest first, with their author and last editor. */
export const THREAD_COMMENTS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body author { __typename login } editor { __typename login } originalCommit { oid } }
      }
    }
  }
}`

/** The pull request's conversation comments with their author, last editor and whether they are hidden, oldest first. */
export const PULL_REQUEST_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId isMinimized body author { __typename login } editor { __typename login } }
      }
    }
  }
}`

/** Replies in a review thread. */
export const REPLY_TO_THREAD_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { databaseId }
  }
}`

/** Hides a comment as outdated; it stays readable behind a fold. */
export const MINIMIZE_COMMENT_MUTATION = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
    minimizedComment { isMinimized }
  }
}`

/** Marks a review thread resolved. */
export const RESOLVE_THREAD_MUTATION = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) {
    thread { id isResolved }
  }
}`
