import { ConfigError } from '../errors.ts'

export class GitError extends Error {
  override name = 'GitError'
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
  }
}

export interface GitResult {
  exitCode: number
  stdout: Uint8Array
  stderr: string
}

/** Runs git in one repository. Never executes anything from the change itself. */
export class Git {
  private constructor(readonly root: string) {}

  static async open(cwd: string): Promise<Git> {
    const result = await spawnGit(cwd, ['rev-parse', '--show-toplevel'])
    if (result.exitCode !== 0) throw new ConfigError(`${cwd} is not inside a git repository`)
    return new Git(decode(result.stdout).trim())
  }

  /** Runs git and returns the raw result without throwing. */
  exec(args: string[], stdin?: string): Promise<GitResult> {
    return spawnGit(this.root, args, stdin)
  }

  /** Runs git and returns stdout as text; throws GitError on a non-zero exit. */
  async text(args: string[], stdin?: string): Promise<string> {
    const result = await this.exec(args, stdin)
    if (result.exitCode !== 0) throw new GitError(args, result.exitCode, result.stderr)
    return decode(result.stdout)
  }

  /** Resolves a ref to a commit SHA, or throws a ConfigError naming the ref. */
  async resolveCommit(ref: string): Promise<string> {
    if (ref.startsWith('-')) throw new ConfigError(`invalid ref "${ref}"`)
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (result.exitCode !== 0) throw new ConfigError(`unknown git ref "${ref}"`)
    return decode(result.stdout).trim()
  }

  /** Branch name for a ref: `origin/main` and `refs/heads/main` both give `main`. */
  async branchName(ref: string): Promise<string | undefined> {
    const result = await this.exec(['rev-parse', '--symbolic-full-name', ref])
    const full = decode(result.stdout).trim()
    if (result.exitCode !== 0 || !full) return undefined
    if (full.startsWith('refs/heads/')) return full.slice('refs/heads/'.length)
    if (full.startsWith('refs/remotes/')) {
      return full.slice('refs/remotes/'.length).split('/').slice(1).join('/') || undefined
    }
    return undefined
  }

  async mergeBase(a: string, b: string): Promise<string> {
    const result = await this.exec(['merge-base', a, b])
    if (result.exitCode !== 0) throw new ConfigError(`no merge base between ${a} and ${b}`)
    return decode(result.stdout).trim()
  }
}

const textDecoder = new TextDecoder()

export function decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

async function spawnGit(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-c', 'core.quotepath=off', ...args], {
    cwd,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}
