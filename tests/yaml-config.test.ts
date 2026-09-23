// YAML → Workspace converter: schema validation, variable substitution,
// and real workspaces built from the example files under workspaces/.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@struktoai/mirage-node'
import {
  WorkspaceConfigError,
  buildWorkspace,
  loadWorkspace,
  parseWorkspaceConfig,
  type BuiltWorkspace,
} from '../src/config.js'
import { VFS_ROOT, readFile, writeText } from '../src/workspace.js'

const WORKSPACES = fileURLToPath(new URL('../workspaces/', import.meta.url))
const opened: Workspace[] = []

afterAll(async () => {
  await Promise.all(opened.map((ws) => ws.close()))
})

async function open(file: string, vars: Record<string, string> = {}): Promise<BuiltWorkspace> {
  const built = await loadWorkspace(join(WORKSPACES, file), { vars })
  opened.push(built.ws)
  return built
}

async function py(ws: Workspace, script: string) {
  await writeText(ws, '/data/t.py', script)
  const io = await ws.execute('python3 /data/t.py')
  return { out: io.stdoutText, err: io.stderrText, code: io.exitCode }
}

const MINIMAL = `
mounts:
  /data:
    type: ram
`

describe('parseWorkspaceConfig', () => {
  it('applies defaults', () => {
    const c = parseWorkspaceConfig(MINIMAL)
    expect(c.mode).toBe('exec')
    expect(c.mounts['/data'].type).toBe('ram')
    expect(c.runtimes).toBeUndefined()
  })

  it('rejects unknown keys with their path', () => {
    expect(() => parseWorkspaceConfig(`${MINIMAL}    colour: red\n`)).toThrow(/colour/)
    expect(() => parseWorkspaceConfig(`${MINIMAL}runtime: []\n`)).toThrow(/runtime/)
  })

  it('rejects a bad mode, a non-absolute prefix, and a disk mount without root', () => {
    expect(() => parseWorkspaceConfig(`mode: rw\n${MINIMAL}`)).toThrow(WorkspaceConfigError)
    expect(() => parseWorkspaceConfig('mounts:\n  data:\n    type: ram\n')).toThrow(/absolute path/)
    expect(() => parseWorkspaceConfig('mounts:\n  /out:\n    type: disk\n')).toThrow(/root/)
  })

  it('rejects an unknown pyodide config key and an unknown runtime type', () => {
    const bad = `${MINIMAL}runtimes:\n  - type: pyodide\n    config:\n      package: [numpy]\n`
    expect(() => parseWorkspaceConfig(bad)).toThrow(/package/)
    const badType = `${MINIMAL}runtimes:\n  - type: cpython\n`
    expect(() => parseWorkspaceConfig(badType)).toThrow(WorkspaceConfigError)
  })

  it('rejects prefixes the Pyodide interpreter owns (/lib holds the stdlib and site-packages)', () => {
    for (const p of ['/lib', '/lib/', '/dev', '/proc']) {
      expect(() => parseWorkspaceConfig(`mounts:\n  ${p}:\n    type: ram\n`), p).toThrow(/reserved/)
    }
  })

  it('rejects clean/wipe on a ram mount (disk only)', () => {
    expect(() => parseWorkspaceConfig('mounts:\n  /d:\n    type: ram\n    wipe: true\n')).toThrow(/wipe/)
  })

  it('substitutes ${VAR} from vars, then env, then the default', () => {
    const text = 'name: ${A}-${B:-fallback}-${HOME_TEST_VAR}\n' + MINIMAL
    process.env.HOME_TEST_VAR = 'fromenv'
    try {
      const c = parseWorkspaceConfig(text, { vars: { A: 'x' } })
      expect(c.name).toBe('x-fallback-fromenv')
      expect(() => parseWorkspaceConfig('name: ${MISSING_VAR_XYZ}\n' + MINIMAL)).toThrow(/MISSING_VAR_XYZ/)
    } finally {
      delete process.env.HOME_TEST_VAR
    }
  })

  it('reports invalid YAML and a non-mapping document', () => {
    expect(() => parseWorkspaceConfig('mounts: [\n')).toThrow(/invalid YAML/)
    expect(() => parseWorkspaceConfig('- a\n')).toThrow(/mapping/)
  })
})

describe('workspaces/default.yaml', () => {
  it('builds the same workspace createWorkspace does', async () => {
    const built = await open('default.yaml')
    expect(built.mountInfo['/data']).toMatch(/In-memory/)
    expect(built.diskRoots['/out']).toBe(VFS_ROOT.replace(/[\\/]$/, ''))
    const r = await py(built.ws, 'import numpy, pandas, os; print(numpy.__version__, sorted(os.listdir("/")))')
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/^\d+\.\d+/)
    expect(r.out).toContain("'data'")
    expect(r.out).toContain("'out'")
  })
})

describe('workspaces/numpy-only.yaml: selecting python packages', () => {
  it('has numpy, denies pandas, and ran the bootstrap code', async () => {
    const built = await open('numpy-only.yaml')
    const ok = await py(built.ws, 'import numpy as np; print(np.linalg.det(np.eye(3)))')
    expect(ok.code, ok.err).toBe(0)
    expect(ok.out.trim()).toBe('1.0')

    const denied = await py(built.ws, 'import pandas')
    expect(denied.code).not.toBe(0)
    expect(denied.err).toMatch(/pandas/)

    // bootstrapCode silenced warnings: warnings.warn prints nothing on stderr.
    const quiet = await py(built.ws, 'import warnings; warnings.warn("boo"); print("ok")')
    expect(quiet.code).toBe(0)
    expect(quiet.err).not.toMatch(/boo/)
  })
})

describe('workspaces/tenant.yaml: vars, seeds, per-mount mode, disk root', () => {
  it('builds a per-tenant workspace from vars', async () => {
    const built = await open('tenant.yaml', { TENANT_ID: 'yaml-t1', TENANT_SECRET: 'S3CR3T' })
    expect(built.config.name).toBe('tenant-yaml-t1')
    expect(built.config.options?.agentId).toBe('agent-yaml-t1')
    expect(built.diskRoots['/out']).toBe(join(VFS_ROOT, 'tenants', 'yaml-t1'))
    expect(existsSync(built.diskRoots['/out'])).toBe(true)

    // Inline seed with a var, seed from a host file, and a block-scalar seed.
    expect((await readFile(built.ws, '/data/secret.txt')).trim()).toBe('S3CR3T')
    expect((await readFile(built.ws, '/data/hello.txt')).trim()).toBe('hello from a host file')
    expect((await readFile(built.ws, '/data/sub/nested.txt')).trim()).toBe('nested seed')
    expect(await readFile(built.ws, '/ref/constants.csv')).toContain('pi,3.14159')
    // seedDir copied the whole fixtures directory into the read-only /vendor mount.
    expect((await readFile(built.ws, '/vendor/hello.txt')).trim()).toBe('hello from a host file')
    const seedDirMissing = parseWorkspaceConfig('mounts:\n  /x:\n    type: ram\n    seedDir: ./nope\n')
    await expect(buildWorkspace(seedDirMissing, { baseDir: WORKSPACES })).rejects.toThrow(/seedDir/)

    // Python sees all three mounts, and writes to /out land under the tenant root.
    const r = await py(
      built.ws,
      [
        'import os, pandas as pd',
        'df = pd.read_csv("/ref/constants.csv")',
        'open("/out/sum.txt", "w").write(str(df.value.sum()))',
        'print(sorted(os.listdir("/")))',
      ].join('\n'),
    )
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(join(built.diskRoots['/out'], 'sum.txt'), 'utf8')).toMatch(/^5\.859/)

    // The read-only mount refuses writes from the shell and from python.
    const sh = await built.ws.execute('echo x > /ref/new.txt')
    expect(sh.exitCode).not.toBe(0)
    const pyw = await py(built.ws, 'open("/ref/new.txt", "w").write("x")')
    expect(pyw.code).not.toBe(0)
    expect(readdirSync(built.diskRoots['/out'])).toEqual(['sum.txt'])
  })

  it('fails loudly when TENANT_ID is missing', async () => {
    await expect(loadWorkspace(join(WORKSPACES, 'tenant.yaml'))).rejects.toThrow(/TENANT_ID/)
  })

  it('fails loudly when a seed host file is missing', async () => {
    const config = parseWorkspaceConfig('mounts:\n  /data:\n    type: ram\n    seed:\n      x.txt: { file: ./nope.txt }\n')
    await expect(buildWorkspace(config, { baseDir: WORKSPACES })).rejects.toThrow(/nope\.txt/)
  })
})
