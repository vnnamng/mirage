// Proves the recommended wiring for "mirage MCP server + deepagents":
//
//   one mirage Workspace, two doors on the SAME instance
//     - deepagents door: LangchainWorkspace(ws)   (SandboxBackendProtocolV2)
//     - external door:   createMirageMcpServer(ws) reached through an MCP
//                        Client over the SDK's in-memory transport
//
// Nothing is proxied over MCP on the deepagents side. The test shows that a
// file written through either door is immediately visible through the other,
// that both `execute` paths share one Pyodide queue (runs serialize, never
// interleave), and that the MCP door's stale-write guard is the only place
// that guard exists.
//
// No API key needed: the deepagents backend is exercised directly.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@struktoai/mirage-node'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { LangchainWorkspace } from '@struktoai/mirage-agents/langchain'
import { createMirageMcpServer } from '@struktoai/mirage-agents/mcp'
import { VFS_ROOT, createWorkspace } from '../src/workspace.js'

/** Host directory backing /out for this test only, so other suites' outputs are untouched. */
const ROOT = join(VFS_ROOT, 'mcp-door')

let ws: Workspace
let backend: LangchainWorkspace
let server: McpServer
let client: Client

beforeAll(async () => {
  ws = await createWorkspace({
    root: ROOT,
    clean: ['from-agent.txt', 'agent-run.json', 'mcp-run.json'],
    seed: { 'hello.txt': 'hello from ram\n' },
  })
  backend = new LangchainWorkspace(ws)
  server = createMirageMcpServer(ws)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'mcp-door-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client?.close()
  await server?.close()
  await ws?.close()
})

/** Concatenate the text blocks of an MCP tool result. */
function text(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}

function isError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError)
}

describe('one Workspace, two doors: deepagents backend + mirage MCP server', () => {
  it('the MCP door exposes exactly the six mirage tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['edit', 'execute_command', 'grep', 'ls', 'read', 'write'].sort(),
    )
  })

  it('the deepagents backend has the sandbox id that keeps the execute tool enabled', () => {
    expect(typeof backend.id).toBe('string')
    expect(backend.id.length).toBeGreaterThan(0)
    expect(typeof backend.execute).toBe('function')
  })

  it('a file written through the deepagents backend is readable through MCP', async () => {
    const written = await backend.write('/out/from-agent.txt', 'written by agent\nsecond line\n')
    expect(written.error).toBeUndefined()

    const res = await client.callTool({ name: 'read', arguments: { path: '/out/from-agent.txt' } })
    expect(isError(res)).toBe(false)
    const body = text(res)
    expect(body).toContain('written by agent')
    // The MCP door returns line-numbered text, not raw content.
    expect(body).toMatch(/^\s+1\twritten by agent/)
  })

  it('a file written through MCP is visible through the deepagents backend', async () => {
    const res = await client.callTool({
      name: 'write',
      arguments: { path: '/data/from-mcp.txt', content: 'written by mcp client\n' },
    })
    expect(isError(res)).toBe(false)

    const read = await backend.read('/data/from-mcp.txt')
    expect(read.error).toBeUndefined()
    expect(String(read.content)).toContain('written by mcp client')

    const listing = await backend.ls('/data')
    expect(listing.error).toBeUndefined()
    const paths = (listing.files ?? []).map((e) => e.path)
    expect(paths).toContain('/data/from-mcp.txt')
    expect(paths).toContain('/data/hello.txt')
  })

  it('both doors run python3 through one Pyodide queue (runs serialize, never overlap)', async () => {
    const script = (out: string) =>
      `python3 -c "import time,json; s=time.time(); time.sleep(0.3); e=time.time(); open('${out}','w').write(json.dumps([s,e])); print('ok')"`

    const [agentRun, mcpRun] = await Promise.all([
      backend.execute(script('/out/agent-run.json')),
      client.callTool({ name: 'execute_command', arguments: { command: script('/out/mcp-run.json') } }),
    ])
    expect(agentRun.exitCode).toBe(0)
    expect(agentRun.output).toContain('ok')
    expect(isError(mcpRun)).toBe(false)
    expect(text(mcpRun)).toContain('ok')

    const a = JSON.parse(String((await backend.read('/out/agent-run.json')).content).replace(/^\s*\d+\t/gm, '')) as [number, number]
    const b = JSON.parse(String((await backend.read('/out/mcp-run.json')).content).replace(/^\s*\d+\t/gm, '')) as [number, number]
    // Intervals [s,e] must not overlap: one run finished before the other started.
    const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0])
    expect(overlap).toBeLessThanOrEqual(0)
  })

  it('the stale-write guard lives only on the MCP door', async () => {
    // External client reads the file (records its version)...
    await client.callTool({ name: 'read', arguments: { path: '/out/from-agent.txt' } })

    // ...the agent changes it through its backend, which has no such guard...
    const edited = await backend.edit('/out/from-agent.txt', 'written by agent', 'written by AGENT')
    expect(edited.error).toBeUndefined()

    // ...so the external client's edit is refused as stale...
    const stale = await client.callTool({
      name: 'edit',
      arguments: { path: '/out/from-agent.txt', old_string: 'second line', new_string: 'SECOND LINE' },
    })
    expect(isError(stale)).toBe(true)
    expect(text(stale)).toMatch(/changed|stale|modified/i)

    // ...until it re-reads, after which the edit lands and the agent sees it.
    await client.callTool({ name: 'read', arguments: { path: '/out/from-agent.txt' } })
    const ok = await client.callTool({
      name: 'edit',
      arguments: { path: '/out/from-agent.txt', old_string: 'second line', new_string: 'SECOND LINE' },
    })
    expect(isError(ok)).toBe(false)

    const final = await backend.read('/out/from-agent.txt')
    expect(String(final.content)).toContain('written by AGENT')
    expect(String(final.content)).toContain('SECOND LINE')
  })
})
