// Design E prototype: a deepagents backend whose every method is a call to
// the eleven backend-shaped tools served by src/mcp-backend-server.ts.
//
// This is a *backend*, not a Workspace. It does not rebuild mounts or a
// Pyodide runtime on the agent side; those stay in the process that owns the
// Workspace. deepagents only ever needs the SandboxBackendProtocolV2 object.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  DeleteResult,
  EditResult,
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from 'deepagents'
import { decodeBytes } from './mcp-backend-server.js'

export interface RemoteMirageBackendOptions {
  /** Non-empty, or deepagents silently drops the execute tool. */
  id?: string
  /** Per-call MCP request timeout. Python runs can exceed the SDK's 60 s default. */
  timeoutMs?: number
}

export class RemoteMirageBackend implements SandboxBackendProtocolV2 {
  readonly id: string
  private readonly timeoutMs: number

  constructor(private readonly client: Client, options: RemoteMirageBackendOptions = {}) {
    this.id = options.id ?? 'mirage-remote'
    this.timeoutMs = options.timeoutMs ?? 600_000
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs })
    if (res.isError) {
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
        .join('')
      throw new Error(`${name} failed: ${text}`)
    }
    const structured = res.structuredContent as { result?: unknown } | undefined
    return decodeBytes(structured?.result) as T
  }

  ls(path: string): Promise<LsResult> {
    return this.call('backend_ls', { path })
  }

  read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.call('backend_read', { path, offset, limit })
  }

  readRaw(path: string): Promise<ReadRawResult> {
    return this.call('backend_read_raw', { path })
  }

  write(path: string, content: string): Promise<WriteResult> {
    return this.call('backend_write', { path, content })
  }

  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.call('backend_edit', { path, oldString, newString, replaceAll })
  }

  delete(path: string): Promise<DeleteResult> {
    return this.call('backend_delete', { path })
  }

  grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number): Promise<GrepResult> {
    return this.call('backend_grep', { pattern, path: path ?? undefined, glob: glob ?? undefined, maxCount })
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.call('backend_glob', { pattern, path })
  }

  execute(command: string): Promise<ExecuteResponse> {
    return this.call('backend_execute', { command })
  }

  uploadFiles(files: readonly (readonly [string, Uint8Array])[]): Promise<FileUploadResponse[]> {
    return this.call('backend_upload_files', {
      files: files.map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes).toString('base64') })),
    })
  }

  downloadFiles(paths: readonly string[]): Promise<FileDownloadResponse[]> {
    return this.call('backend_download_files', { paths: [...paths] })
  }
}
