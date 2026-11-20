import { BOT_SLUG_PATTERN } from '@mng-review/domain'
import type {
	ChosenHandle,
	CommandHandles,
	DeniedCommand,
} from './command.types'

/**
 * The handle a command must mention: exactly one of `app-slug` and `handle`, and a valid slug.
 * There is no default, so a repository with neither input runs no command, and nothing from a
 * comment or a pull request ever becomes the handle.
 */
export function getCommandHandle(
	handles: CommandHandles
): ChosenHandle | DeniedCommand {
	const appSlug = handles.appSlug.trim()
	const handle = handles.handle.trim()
	if (appSlug !== '' && handle !== '')
		return {
			status: 'denied',
			reason: 'app-slug and handle are both set; set one of them',
		}
	const chosen = appSlug || handle
	if (chosen === '')
		return { status: 'denied', reason: 'neither app-slug nor handle is set' }
	if (!BOT_SLUG_PATTERN.test(chosen))
		return { status: 'denied', reason: 'the handle is not a valid login' }
	return { status: 'chosen', handle: chosen }
}
