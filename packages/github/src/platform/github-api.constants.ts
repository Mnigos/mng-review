import { Duration, Schedule } from 'effect'

export const API_VERSION = '2022-11-28'
export const PAGE_SIZE = 100
/** At most this many pages are read; a pull request with more fails the read instead of being cut. */
export const MAX_PAGES = 20
export const SERVER_ERROR_STATUS = 500
/** One request, its body included, may take this long; a hung request would hold the job. */
export const REQUEST_TIMEOUT = Duration.seconds(30)
/** Reads are retried twice on a network failure, a timeout or a 5xx; writes never, so nothing is posted twice. */
export const READ_RETRIES = 2
export const READ_RETRY = Schedule.exponential('500 millis')

/** The pull request's review threads with their first comment, oldest first. */
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
        }
      }
    }
  }
}`

/** The pull request's conversation comments with their author and last editor, oldest first. */
export const PULL_REQUEST_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body author { __typename login } editor { __typename login } }
      }
    }
  }
}`
