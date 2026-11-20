import { Schema } from 'effect'

/** A full commit SHA, SHA-1 or SHA-256, so a ref from outside can never read as a git option. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
export const commitShaSchema = Schema.String.check(Schema.isPattern(COMMIT_SHA))
