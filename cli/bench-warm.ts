// Splits a fresh instance's first-call time into interpreter boot, numpy
// import, and pandas import, then tries pre-warming a PyodideRuntime before
// any tenant workspace exists (a pool), measuring what the tenant's first
// call costs afterwards.
//
//   node --expose-gc cli/bench-warm.ts
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DiskResource, MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { PyodideRuntime } from '@struktoai/mirage-core/runtime/python/pyodide'
import { VFS_ROOT, writeText } from '../src/workspace.ts'

const MB = (b: number) => (b / 1024 / 1024).toFixed(0)
const rss = () => {
  ;(globalThis as any).gc?.()
  return process.memoryUsage().rss
}
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const v = await fn()
  return [v, performance.now() - t0]
}

function makeRuntime(packages: string[]) {
  return new PyodideRuntime({ config: { packages } })
}

function makeWorkspace(runtime: PyodideRuntime, id: string) {
  const root = join(VFS_ROOT, 'tenants', id)
  mkdirSync(root, { recursive: true })
  const ram = new RAMResource()
  const disk = new DiskResource({ root })
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  for (const op of disk.ops()) ops.register(op)
  return new Workspace({ '/data': ram, '/out': disk }, { mode: MountMode.EXEC, ops, runtimes: [runtime, 'vfs'] })
}

async function py(ws: Workspace, code: string) {
  await writeText(ws, '/data/b.py', code)
  const io = await ws.execute('python3 /data/b.py')
  if (io.exitCode !== 0) throw new Error(io.stderrText)
  return io.stdoutText
}

async function main() {
  console.log(`baseline rss ${MB(rss())}MB\n`)

  // ── A. breakdown: no preloaded packages, lazy imports ──
  {
    const r0 = rss()
    const ws = makeWorkspace(makeRuntime([]), 'warm-a')
    const [, boot] = await timed(() => py(ws, 'print(1)'))
    const r1 = rss()
    const [, np] = await timed(() => py(ws, 'import numpy'))
    const r2 = rss()
    const [, pd] = await timed(() => py(ws, 'import pandas'))
    const r3 = rss()
    const [, again] = await timed(() => py(ws, 'import numpy, pandas; print(2)'))
    console.log('A. cold instance, packages loaded lazily on import')
    console.table([
      { phase: 'interpreter boot (print 1)', ms: boot.toFixed(0), 'Δrss MB': MB(r1 - r0) },
      { phase: 'import numpy (fetch wheel + init)', ms: np.toFixed(0), 'Δrss MB': MB(r2 - r1) },
      { phase: 'import pandas (fetch wheels + init)', ms: pd.toFixed(0), 'Δrss MB': MB(r3 - r2) },
      { phase: 'import both again (warm)', ms: again.toFixed(0), 'Δrss MB': '0' },
    ])
    await ws.close()
  }

  // ── B. preloaded packages at init (what createWorkspace does) ──
  {
    const r0 = rss()
    const ws = makeWorkspace(makeRuntime(['numpy', 'pandas']), 'warm-b')
    const [, boot] = await timed(() => py(ws, 'print(1)'))
    const r1 = rss()
    const [, imp] = await timed(() => py(ws, 'import numpy, pandas'))
    const r2 = rss()
    console.log('B. packages preloaded at init (createWorkspace default)')
    console.table([
      { phase: 'boot + install wheels (print 1)', ms: boot.toFixed(0), 'Δrss MB': MB(r1 - r0) },
      { phase: 'first import numpy, pandas', ms: imp.toFixed(0), 'Δrss MB': MB(r2 - r1) },
    ])
    await ws.close()
  }

  // ── C. pre-warmed pool: load + import before the tenant exists ──
  {
    const runtime = makeRuntime(['numpy', 'pandas'])
    const r0 = rss()
    // ensureLoaded is private in the .d.ts but plain JS at runtime.
    const [, warm] = await timed(async () => {
      const pyodide = await (runtime as any).ensureLoaded()
      await pyodide.runPythonAsync('import numpy, pandas')
    })
    const r1 = rss()
    // Tenant arrives now.
    const [ws, construct] = await timed(async () => makeWorkspace(runtime, 'warm-c'))
    const [out, first] = await timed(() => py(ws, 'import numpy, pandas, os; print(sorted(os.listdir("/data")))'))
    const [, second] = await timed(() => py(ws, 'print(1)'))
    console.log('C. runtime pre-warmed in a pool, then attached to a new tenant workspace')
    console.table([
      { phase: 'pool: load + import (off request path)', ms: warm.toFixed(0), 'Δrss MB': MB(r1 - r0) },
      { phase: 'tenant: construct workspace', ms: construct.toFixed(0), 'Δrss MB': '' },
      { phase: 'tenant: first python call', ms: first.toFixed(0), 'Δrss MB': '' },
      { phase: 'tenant: second python call', ms: second.toFixed(0), 'Δrss MB': '' },
    ])
    console.log('first call output:', out.trim())
    await ws.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
