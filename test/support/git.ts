import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Every repository lives outside the checkout and is removed by the owning test's afterEach. */
export class TempRepo {
  private constructor(readonly root: string) {}
  static async create(): Promise<TempRepo> {
    const repo = new TempRepo(await mkdtemp(join(tmpdir(), 'mng-review-test-')))
    try {
      await repo.git('init', '--initial-branch=main')
      return repo
    } catch (error) {
      await repo.cleanup()
      throw error
    }
  }
  async git(...args: string[]): Promise<string> {
    const proc = Bun.spawn(
      [
        'git',
        '-c',
        'user.name=alice',
        '-c',
        'user.email=alice@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: this.root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`fixture git ${args.join(' ')}: ${err}`)
    return out.trim()
  }
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const full = join(this.root, path)
    await mkdir(dirname(full), { recursive: true })
    await Bun.write(full, content)
  }
  async remove(path: string): Promise<void> {
    await rm(join(this.root, path), { recursive: true, force: true })
  }
  async commit(message = 'fixture'): Promise<string> {
    await this.git('add', '--all')
    await this.git('commit', '-m', message)
    return this.git('rev-parse', 'HEAD')
  }
  cleanup(): Promise<void> {
    return rm(this.root, { recursive: true, force: true })
  }
}
