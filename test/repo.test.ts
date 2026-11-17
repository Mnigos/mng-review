import { afterEach, describe, expect, test } from 'bun:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAgents } from '../src/agents/parse.ts'
import { Git } from '../src/git/git.ts'
import { normalizeRepoPath } from '../src/repo/paths.ts'
import { gitRefReader, worktreeReader } from '../src/repo/reader.ts'
import { TempRepo } from './support/git.ts'

describe('normalizeRepoPath', () => {
  test.each(['/a', '../x', 'a/../../x', 'a\\b', 'a\0b', 'C:/x', 'c:x', '\\server\\x'])(
    'refuses unsafe path %p',
    path => {
      expect(normalizeRepoPath(path)).toBeNull()
    },
  )
  test.each([
    ['./a/../b', 'b'],
    ['./src/auth.ts', 'src/auth.ts'],
    ['a//b/', 'a/b'],
    ['', '.'],
    ['.', '.'],
    ['a/..', '.'],
  ])('normalizes %p to %s', (path, expected) => {
    expect(normalizeRepoPath(path)).toBe(expected)
  })
})

describe('repository readers', () => {
  const repos: TempRepo[] = []
  async function temp() {
    const repo = await TempRepo.create()
    repos.push(repo)
    return repo
  }
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(repo => repo.cleanup()))
  })

  test('gitRefReader reads and lists the named commit, ignoring working-tree changes', async () => {
    const repo = await temp()
    await repo.write('.mng/agents/auth.md', '---\nkind: bug\n---\n@/docs/auth.md')
    await repo.write('.mng/agents/billing.md', '---\nkind: bug\n---\nCheck billing.')
    await repo.write('.mng/agents/nested/hidden.md', 'not a direct agent')
    await repo.write('docs/auth.md', 'Committed instructions.')
    const commit = await repo.commit()
    await repo.write('.mng/agents/auth.md', 'working tree instructions')
    await repo.remove('.mng/agents/billing.md')
    await repo.write('.mng/agents/new.md', 'untracked')
    await repo.write('docs/auth.md', 'working tree import')
    const reader = gitRefReader(await Git.open(repo.root), 'main', commit)
    expect(reader.source).toBe('main')
    expect(await reader.readFile('docs/auth.md')).toBe('Committed instructions.')
    expect(await reader.listFiles('.mng/agents')).toEqual(['auth.md', 'billing.md'])
    expect(await reader.readFile('missing')).toBeNull()
    expect(await reader.listFiles('missing')).toBeNull()
    expect((await loadAgents(reader)).map(a => [a.name, a.instructions])).toEqual([
      ['auth', 'Committed instructions.'],
      ['billing', 'Check billing.'],
    ])
  })
  test('worktreeReader reads current files, sorts direct files, and reports a missing directory', async () => {
    const repo = await temp()
    await repo.write('docs/b.md', 'B')
    await repo.write('docs/a.md', 'A')
    await repo.write('docs/nested/c.md', 'C')
    const reader = worktreeReader(repo.root)
    expect(await reader.readFile('docs/a.md')).toBe('A')
    expect(await reader.listFiles('docs')).toEqual(['a.md', 'b.md'])
    expect(await reader.readFile('missing')).toBeNull()
    expect(await loadAgents(reader)).toEqual([])
  })
  test('worktreeReader requires exact filename casing', async () => {
    const repo = await temp()
    await repo.write('.mng/context.md', 'Repository context.')
    const reader = worktreeReader(repo.root)
    expect(await reader.readFile('.mng/CONTEXT.md')).toBeNull()
    expect(await reader.readFile('.mng/context.md')).toBe('Repository context.')
  })
  test('worktreeReader refuses a file or directory symlink outside the root but permits an internal link', async () => {
    const repo = await temp()
    const outside = await temp()
    await outside.write('private.md', 'Outside data')
    await repo.write('inside.md', 'Inside data')
    await symlink(join(outside.root, 'private.md'), join(repo.root, 'escape.md'))
    await symlink(outside.root, join(repo.root, 'escape-dir'))
    await symlink(join(repo.root, 'inside.md'), join(repo.root, 'internal.md'))
    const reader = worktreeReader(repo.root)
    expect(await reader.readFile('escape.md')).toBeNull()
    expect(await reader.listFiles('escape-dir')).toBeNull()
    expect(await reader.readFile('escape-dir/private.md')).toBeNull()
    expect(await reader.readFile('internal.md')).toBe('Inside data')
  })
})
