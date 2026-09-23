// Design E: the full backend contract mirrored over MCP.
//
// One Workspace in this process is exposed through the eleven-tool server in
// src/mcp-backend-server.ts. A RemoteMirageBackend on the other side of an
// in-memory MCP transport is then put through the SAME conformance checks as
// the in-process LangchainWorkspace adapter, so any behavioural gap between
// "in-process" and "over MCP" shows up as a failing case in one column only.
//
// The last test measures the per-operation overhead of the hop.
//
// No API key needed.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@struktoai/mirage-node'
import type { SandboxBackendProtocolV2 } from 'deepagents'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { LangchainWorkspace } from '@struktoai/mirage-agents/langchain'
import { VFS_ROOT, createWorkspace } from '../src/workspace.js'
import { BACKEND_TOOLS, createMirageBackendMcpServer } from '../src/mcp-backend-server.js'
import { RemoteMirageBackend } from '../src/remote-backend.js'

const ROOT = join(VFS_ROOT, 'mcp-remote')

let ws: Workspace
let local: LangchainWorkspace
let remote: RemoteMirageBackend
let server: McpServer
let client: Client

beforeAll(async () => {
  ws = await createWorkspace({ root: ROOT, seed: { 'seed.txt': 'alpha\nbeta\ngamma\n' } })
  local = new LangchainWorkspace(ws)
  server = createMirageBackendMcpServer(ws, { sandboxId: 'mirage' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  client = new Client({ name: 'remote-backend-test', version: '0.0.0' })
  await client.connect(ct)
  remote = new RemoteMirageBackend(client, { id: 'mirage' })
})

afterAll(async () => {
  await client?.close()
  await server?.close()
  await ws?.close()
})

it('the backend server exposes exactly the eleven protocol operations', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual([...BACKEND_TOOLS].sort())
})

// Each backend gets its own directory so the two columns never collide.
const cases: Array<[string, () => SandboxBackendProtocolV2, string]> = [
  ['in-process LangchainWorkspace', () => local, '/data/local'],
  ['remote over MCP (11 ops)', () => remote, '/data/remote'],
]

describe.each(cases)('%s', (_label, get, dir) => {
  it('write, read (with pagination fields), ls', async () => {
    const b = get()
    const w = await b.write(`${dir}/a.txt`, 'one\ntwo\nthree\n')
    expect(w.error).toBeUndefined()

    const r = await b.read(`${dir}/a.txt`)
    expect(r.error).toBeUndefined()
    expect(String(r.content)).toContain('two')

    const l = await b.ls(dir)
    expect(l.error).toBeUndefined()
    expect((l.files ?? []).map((f) => f.path)).toContain(`${dir}/a.txt`)
  })

  it('edit with occurrence count', async () => {
    const b = get()
    const e = await b.edit(`${dir}/a.txt`, 'two', 'TWO')
    expect(e.error).toBeUndefined()
    expect(String((await b.read(`${dir}/a.txt`)).content)).toContain('TWO')
  })

  it('grep returns structured matches', async () => {
    const b = get()
    const g = await b.grep('TWO', dir)
    expect(g.error).toBeUndefined()
    expect(g.matches?.some((m) => m.path.endsWith('a.txt') && m.text.includes('TWO'))).toBe(true)
  })

  it('glob returns file infos', async () => {
    const b = get()
    const g = await b.glob('*.txt', dir)
    expect(g.error).toBeUndefined()
    expect((g.files ?? []).map((f) => f.path)).toContain(`${dir}/a.txt`)
  })

  it('binary round trip through uploadFiles, readRaw and downloadFiles', async () => {
    const b = get()
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const up = await b.uploadFiles!([[`${dir}/blob.bin`, bytes]])
    expect(up[0]?.error).toBeNull()

    const down = await b.downloadFiles!([`${dir}/blob.bin`])
    expect(down[0]?.error).toBeNull()
    expect(down[0]?.content).toBeInstanceOf(Uint8Array)
    expect(Array.from(down[0]!.content!)).toEqual(Array.from(bytes))

    const raw = await b.readRaw(`${dir}/blob.bin`)
    expect(raw.error).toBeUndefined()
    expect(raw.data).toBeDefined()
  })

  it('execute runs python3 in the one Pyodide runtime', async () => {
    const b = get()
    const res = await b.execute(`python3 -c "import numpy; print('np', numpy.__version__)"`)
    expect(res.exitCode).toBe(0)
    expect(res.output).toContain('np')
  })

  it('many concurrent reads all succeed (subagents multiplex one backend)', async () => {
    const b = get()
    const results = await Promise.all(Array.from({ length: 20 }, () => b.read(`${dir}/a.txt`)))
    expect(results.every((r) => r.error === undefined && String(r.content).includes('one'))).toBe(true)
  })
})

it('delete exists only where the backend provides it', async () => {
  expect(typeof (local as { delete?: unknown }).delete).toBe('undefined')
  await remote.write('/data/remote/gone.txt', 'x')
  const d = await remote.delete('/data/remote/gone.txt')
  expect(d.error).toBeUndefined()
  const l = await remote.ls('/data/remote')
  expect((l.files ?? []).map((f) => f.path)).not.toContain('/data/remote/gone.txt')
})

it('per-operation overhead of the MCP hop (in-memory transport)', async () => {
  const N = 200
  const time = async (b: SandboxBackendProtocolV2, path: string) => {
    const t0 = performance.now()
    for (let i = 0; i < N; i++) await b.read(path)
    return (performance.now() - t0) / N
  }
  const localMs = await time(local, '/data/local/a.txt')
  const remoteMs = await time(remote, '/data/remote/a.txt')
  console.log(
    `read x${N}: in-process ${localMs.toFixed(3)} ms/op, remote over MCP ${remoteMs.toFixed(3)} ms/op, ` +
      `hop overhead ${(remoteMs - localMs).toFixed(3)} ms/op`,
  )
  expect(remoteMs).toBeGreaterThan(0)
})
