import type { DeclaredAgent } from '../../agents/agent.types'
import type { ChangedFile } from '../../change/change.types'
import { getReviewableFiles } from '../../change/file-skip.helper'
import { matchesAnyGlob } from '../../utils/glob.util'
import type { PullRequestInfo, RuleSelection } from '../routing.types'

/** True when the file matches at its new path or, for a rename or copy, its old path. */
function matchesAtEitherPath(
	file: ChangedFile,
	patterns: readonly string[]
): boolean {
	return (
		matchesAnyGlob(file.path, patterns) ||
		(file.oldPath !== undefined && matchesAnyGlob(file.oldPath, patterns))
	)
}

/** Why the label, author or target rule fails, or `undefined` when each non-empty list matches. */
function getMetadataMiss(
	agent: DeclaredAgent,
	pr: PullRequestInfo
): string | undefined {
	const { labels, authors, targets } = agent.frontMatter.when
	if (labels.length > 0 && !pr.labels.some(label => labels.includes(label)))
		return 'no label from when.labels'
	if (authors.length > 0 && !(pr.author && authors.includes(pr.author)))
		return 'author not in when.authors'
	if (targets.length > 0 && !(pr.target && targets.includes(pr.target)))
		return 'target branch not in when.targets'
	return undefined
}

/**
 * Applies an agent's `when` rules. Each non-empty list must match: `labels` any pull request label,
 * `authors` the author, `targets` the base branch, and `paths` at least one reviewable file (at its
 * new or old path) whose new path no `exclude` pattern matches. An agent without `paths` covers
 * every reviewable file; a metadata agent without `paths` runs even when none is reviewable.
 */
export function selectByRules(
	agent: DeclaredAgent,
	files: readonly ChangedFile[],
	pr: PullRequestInfo
): RuleSelection {
	const metadataMiss = getMetadataMiss(agent, pr)
	if (metadataMiss)
		return { selected: false, reason: metadataMiss, routable: false, files: [] }
	const { paths, exclude, triage } = agent.frontMatter.when
	const inScope = getReviewableFiles(files).filter(
		file => !matchesAnyGlob(file.path, exclude)
	)
	const inScopePaths = inScope.map(file => file.path)
	if (paths.length === 0) {
		if (inScope.length > 0 || agent.frontMatter.input === 'metadata')
			return { selected: true, files: inScopePaths }
		return {
			selected: false,
			reason: 'no reviewable file in scope',
			routable: false,
			files: [],
		}
	}
	const matched = inScope.filter(file => matchesAtEitherPath(file, paths))
	if (matched.length > 0)
		return { selected: true, files: matched.map(file => file.path) }
	return {
		selected: false,
		reason: 'no changed file matches when.paths',
		routable: inScope.length > 0 && triage !== undefined,
		files: inScopePaths,
	}
}

/** Reviewable files under `risk_paths`, matched at their new or old path, named by the new path. */
export function getRiskPathHits(
	files: readonly ChangedFile[],
	riskPaths: readonly string[]
): string[] {
	return getReviewableFiles(files)
		.filter(file => matchesAtEitherPath(file, riskPaths))
		.map(file => file.path)
}
