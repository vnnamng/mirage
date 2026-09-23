// Design E prototype: expose the FULL deepagents backend contract over MCP.
//
// The stock mirage MCP server (`@struktoai/mirage-agents/mcp`) registers six
// LLM-facing tools that return prose. This server instead registers one tool
// per SandboxBackendProtocolV2 method (eleven in total) and returns the
// method's structured result verbatim as `structuredContent`, with binary
// fields base64-encoded. It is meant to be consumed by a program (the
// RemoteMirageBackend in src/remote-backend.ts), never by a model, so it has
// no descriptions tuned for an LLM and no stale-write guard.
//
// Implementation is deliberately thin: every tool delegates to the in-process
// LangchainWorkspace adapter, so the server adds only serialisation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Workspace } from '@struktoai/mirage-node'
import { LangchainWorkspace } from '@struktoai/mirage-agents/langchain'
import { z } from 'zod'

export const BACKEND_TOOLS = [
  'backend_ls',
  'backend_read',
  'backend_read_raw',
  'backend_write',
  'backend_edit',
  'backend_delete',
  'backend_grep',
  'backend_glob',
  'backend_execute',
  'backend_upload_files',
  'backend_download_files',
] as const

/** Marker object used to carry Uint8Array values through JSON. */
interface BytesEnvelope { $bytes: string }

/** Replace every Uint8Array in a result tree with a base64 envelope. */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') } satisfies BytesEnvelope
  if (Array.isArray(value)) return value.map(encodeBytes)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = encodeBytes(v)
    return out
  }
  return value
}

/** Inverse of encodeBytes. */
export function decodeBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBytes)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$bytes === 'string' && Object.keys(obj).length === 1) {
      return new Uint8Array(Buffer.from(obj.$bytes, 'base64'))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = decodeBytes(v)
    return out
  }
  return value
}

export interface BackendMcpServerOptions {
  name?: string
  version?: string
  /** Sandbox id reported to deepagents by the remote proxy. */
  sandboxId?: string
}

export function createMirageBackendMcpServer(ws: Workspace, options: BackendMcpServerOptions = {}): McpServer {
  const backend = new LangchainWorkspace(ws, { sandboxId: options.sandboxId })
  const server = new McpServer({ name: options.name ?? 'mirage-backend', version: options.version ?? '0.0.0' })

  const output = { result: z.unknown() }
  const wrap = (result: unknown) => {
    const encoded = encodeBytes(result)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(encoded) }],
      structuredContent: { result: encoded },
    }
  }

  server.registerTool(
    'backend_ls',
    { description: 'BackendProtocolV2.ls', inputSchema: { path: z.string() }, outputSchema: output },
    async ({ path }) => wrap(await backend.ls(path)),
  )
  server.registerTool(
    'backend_read',
    {
      description: 'BackendProtocolV2.read',
      inputSchema: { path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() },
      outputSchema: output,
    },
    async ({ path, offset, limit }) => wrap(await backend.read(path, offset, limit)),
  )
  server.registerTool(
    'backend_read_raw',
    { description: 'BackendProtocolV2.readRaw', inputSchema: { path: z.string() }, outputSchema: output },
    async ({ path }) => wrap(await backend.readRaw(path)),
  )
  server.registerTool(
    'backend_write',
    { description: 'BackendProtocolV2.write', inputSchema: { path: z.string(), content: z.string() }, outputSchema: output },
    async ({ path, content }) => wrap(await backend.write(path, content)),
  )
  server.registerTool(
    'backend_edit',
    {
      description: 'BackendProtocolV2.edit',
      inputSchema: {
        path: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      },
      outputSchema: output,
    },
    async ({ path, oldString, newString, replaceAll }) => wrap(await backend.edit(path, oldString, newString, replaceAll)),
  )
  server.registerTool(
    'backend_delete',
    { description: 'BackendProtocolV2.delete', inputSchema: { path: z.string() }, outputSchema: output },
    async ({ path }) => {
      // LangchainWorkspace has no delete; go straight to the VFS.
      try {
        await ws.fs.unlink(path)
        return wrap({ path, filesUpdate: null })
      } catch (err) {
        return wrap({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )
  server.registerTool(
    'backend_grep',
    {
      description: 'BackendProtocolV2.grep',
      inputSchema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        maxCount: z.number().int().optional(),
      },
      outputSchema: output,
    },
    async ({ pattern, path, glob, maxCount }) => wrap(await backend.grep(pattern, path ?? null, glob ?? null, maxCount)),
  )
  server.registerTool(
    'backend_glob',
    { description: 'BackendProtocolV2.glob', inputSchema: { pattern: z.string(), path: z.string().optional() }, outputSchema: output },
    async ({ pattern, path }) => wrap(await backend.glob(pattern, path)),
  )
  server.registerTool(
    'backend_execute',
    { description: 'SandboxBackendProtocolV2.execute', inputSchema: { command: z.string() }, outputSchema: output },
    async ({ command }) => wrap(await backend.execute(command)),
  )
  server.registerTool(
    'backend_upload_files',
    {
      description: 'BackendProtocolV2.uploadFiles',
      inputSchema: { files: z.array(z.object({ path: z.string(), bytes: z.string() })) },
      outputSchema: output,
    },
    async ({ files }) =>
      wrap(await backend.uploadFiles(files.map((f) => [f.path, new Uint8Array(Buffer.from(f.bytes, 'base64'))] as const))),
  )
  server.registerTool(
    'backend_download_files',
    { description: 'BackendProtocolV2.downloadFiles', inputSchema: { paths: z.array(z.string()) }, outputSchema: output },
    async ({ paths }) => wrap(await backend.downloadFiles(paths)),
  )

  return server
}
