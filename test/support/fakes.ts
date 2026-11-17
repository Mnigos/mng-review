import type { DeclaredAgent } from '../../src/agents/parse.ts'
import { parseFrontMatter } from '../../src/agents/parse.ts'
import type { ChangedFile } from '../../src/change/change.ts'
import { parseConfig } from '../../src/config/load.ts'
import type { Config } from '../../src/config/schema.ts'
import {
  TokenLedger,
  type ChatRequest,
  type ChatResponse,
  type LlmClient,
} from '../../src/llm/types.ts'
import type { RepoReader } from '../../src/repo/reader.ts'
import type { PullRequestInfo } from '../../src/routing/context.ts'

export class MemoryReader implements RepoReader {
  readonly source = 'in-memory base commit'
  readonly reads: string[] = []
  constructor(readonly files: Record<string, string> = {}) {}
  async readFile(path: string): Promise<string | null> {
    this.reads.push(path)
    return this.files[path] ?? null
  }
  async listFiles(path: string): Promise<string[] | null> {
    const names = Object.keys(this.files)
      .filter(name => name.startsWith(`${path}/`))
      .map(name => name.slice(path.length + 1))
      .filter(name => !name.includes('/'))
      .toSorted()
    return names.length ? names : null
  }
}

export function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    model: 'test-model',
    content: null,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    ...overrides,
  }
}

export class ScriptedLlm implements LlmClient {
  readonly tokens = new TokenLedger()
  readonly requests: ChatRequest[] = []
  constructor(private readonly script: Array<ChatResponse | Error> = []) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request)
    const next = this.script.shift()
    if (!next) throw new Error('unexpected model call: script exhausted')
    if (next instanceof Error) throw next
    this.tokens.add(request.model, next.usage)
    return next
  }
}

export function config(yaml: string | null = null): Config {
  return parseConfig(yaml)
}

export function agent(name = 'auth', frontMatter: Record<string, unknown> = {}): DeclaredAgent {
  return {
    name,
    file: `.mng/agents/${name}.md`,
    title: name,
    instructions: 'Check ownership.',
    frontMatter: parseFrontMatter(Bun.YAML.stringify({ kind: 'bug', ...frontMatter }), name),
  }
}

export function file(
  path = 'packages/auth/session.ts',
  overrides: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: 2,
    deletions: 1,
    binary: false,
    sizeBytes: 40,
    ...overrides,
  }
}

export function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    author: 'alice',
    target: 'main',
    labels: [],
    draft: false,
    fork: false,
    trigger: 'auto',
    ...overrides,
  }
}
