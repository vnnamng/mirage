// Builds the mirage Workspace used by the tests and the chat CLI.
//
//   /data  RAMResource   inputs, live only in memory
//   /out   DiskResource  outputs, persisted to the project's vfs/ directory
//
// python3 is answered by the Pyodide runtime with numpy and pandas preloaded.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DiskResource,
  MountMode,
  OpsRegistry,
  RAMResource,
  Workspace,
} from '@struktoai/mirage-node'
import { PyodideRuntime } from '@struktoai/mirage-core/runtime/python/pyodide'

/** Host directory that backs the /out mount. */
export const VFS_ROOT = fileURLToPath(new URL('../vfs/', import.meta.url))

export const MOUNT_INFO = {
  '/data': 'In-memory filesystem holding input files (read/write).',
  '/out': 'Disk-backed filesystem for output files (read/write).',
}

export interface WorkspaceOptions {
  /** Text files to create under /data before returning, by file name. */
  seed?: Record<string, string>
  /** File names under /out to delete before returning. */
  clean?: string[]
  /**
   * Host directory backing the /out mount. Defaults to the project vfs/
   * folder; a multi-tenant deployment gives every tenant its own root.
   */
  root?: string
}

export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const root = options.root ?? VFS_ROOT
  mkdirSync(root, { recursive: true })
  for (const name of options.clean ?? []) rmSync(join(root, name), { force: true })

  const ram = new RAMResource()
  const disk = new DiskResource({ root })
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  for (const op of disk.ops()) ops.register(op)

  const ws = new Workspace(
    { '/data': ram, '/out': disk },
    {
      mode: MountMode.EXEC,
      ops,
      runtimes: [
        new PyodideRuntime({
          config: {
            // Preload once at init so `import numpy` / `import pandas`
            // inside guest code never has to resolve wheels lazily.
            packages: ['numpy', 'pandas'],
          },
        }),
        'vfs',
      ],
    },
  )

  for (const [name, content] of Object.entries(options.seed ?? {})) {
    await writeText(ws, `/data/${name}`, content)
  }
  return ws
}

/** Write a text file into the workspace through the shell (heredoc). */
export async function writeText(ws: Workspace, path: string, content: string): Promise<void> {
  const body = content.endsWith('\n') ? content : `${content}\n`
  const io = await ws.execute(`cat > ${path} <<'__MIRAGE_EOF__'\n${body}__MIRAGE_EOF__\n`)
  if (io.exitCode !== 0) {
    throw new Error(`writing ${path} failed (exit ${io.exitCode}): ${io.stderrText}`)
  }
}

/** True when a file written to /out/<name> actually landed on the host disk. */
export function outputExistsOnDisk(name: string): boolean {
  return existsSync(join(VFS_ROOT, name))
}

export async function readFile(ws: Workspace, path: string): Promise<string> {
  const io = await ws.execute(`cat ${path}`)
  if (io.exitCode !== 0) {
    throw new Error(`cat ${path} failed (exit ${io.exitCode}): ${io.stderrText}`)
  }
  return io.stdoutText
}
