import type { ConfirmedEdit, KeptFinding } from '@mng-review/domain'

/** What `isEditOnHeadLine` compares: the finding, the head publishing posts on and its own read of the file there. */
export interface HeadEditInput {
	readonly finding: KeptFinding
	readonly head: string
	/** The finding's file at `head` as publishing read it; `undefined` when the read failed or the file is gone. */
	readonly headText: string | undefined
}

/** The confirmed edit a finding carries, if any. */
export function getConfirmedEdit(
	finding: KeptFinding
): ConfirmedEdit | undefined {
	const { validation } = finding
	return validation?.status === 'confirmed' ? validation.edit : undefined
}

/**
 * True when the finding's edit names `head`, the finding's line, and that line's exact text in
 * publishing's own read of the file. The outcome file comes from a job that runs model code, so a
 * finding moved to another line with matching edit metadata fails here and posts no suggestion.
 */
export function isEditOnHeadLine(input: HeadEditInput): boolean {
	const { finding, head, headText } = input
	const edit = getConfirmedEdit(finding)
	if (!edit || headText === undefined) return false
	if (edit.commit !== head || edit.line !== finding.line) return false
	return headText.split('\n')[edit.line - 1] === edit.original
}

/** The finding without its confirmed edit, so its comment shows the fix as text only. */
export function toWithoutEdit(finding: KeptFinding): KeptFinding {
	const { validation } = finding
	if (validation?.status !== 'confirmed' || !validation.edit) return finding
	const { edit: _edit, ...judgement } = validation
	return { ...finding, validation: judgement }
}
