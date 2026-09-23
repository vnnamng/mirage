// Measures what a per-tenant Pyodide workspace costs: setup time per phase,
// memory per instance, whether instances run in parallel, and what close()
// gives back.
//
//   node --expose-gc cli/bench-tenants.ts [tenants=3]
//
// Phases per tenant:
//   construct   new Workspace(...)            (no python yet)
//   first call  python3 -c "import numpy, pandas"  (loadPyodide + wheels)
//   warm call   python3 -c "print(1)"
//   pandas call read_csv + groupby on a small frame
import { performance } from 'node:perf_hooks'
import { createTenant, type Tenant } from '../src/tenant.ts'
import { createWorkspace, writeText } from '../src/workspace.ts'

const N = Number(process.argv[2] ?? 3)
const MB = (b: number) => (b / 1024 / 1024).toFixed(0).padStart(5)

function gc() {
  ;(globalThis as any).gc?.()
}

function mem() {
  gc()
  const m = process.memoryUsage()
  return { rss: m.rss, heap: m.heapUsed, ext: m.external, ab: m.arrayBuffers }
}
type Mem = ReturnType<typeof mem>
const delta = (a: Mem, b: Mem): Mem => ({ rss: b.rss - a.rss, heap: b.heap - a.heap, ext: b.ext - a.ext, ab: b.ab - a.ab })
const fmtMem = (m: Mem) => `rss ${MB(m.rss)}MB  heap ${MB(m.heap)}MB  ext ${MB(m.ext)}MB  arraybuf ${MB(m.ab)}MB`

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const v = await fn()
  return [v, performance.now() - t0]
}

async function py(t: Tenant, code: string) {
  await writeText(t.ws, "/data/bench.py", code)
  const io = await t.ws.execute("python3 /data/bench.py")
  if (io.exitCode !== 0) throw new Error(io.stderrText)
  return io.stdoutText
}

const PANDAS = `
import pandas as pd, io
df = pd.read_csv(io.StringIO("a,b\\n" + "\\n".join(f"{i%5},{i}" for i in range(1000))))
print(df.groupby("a").b.sum().to_dict())`

const SPIN = `
import time
t=time.time()
n=0
while time.time()-t < 1.0: n+=1
print(n)`

async function main() {
  console.log(`node ${process.version}  tenants=${N}  gc=${typeof (globalThis as any).gc === 'function' ? 'exposed' : 'NOT exposed (run with --expose-gc for stable memory numbers)'}`)
  console.log(`baseline: ${fmtMem(mem())}\n`)

  // ── 1. sequential setup cost per tenant ──
  const tenants: Tenant[] = []
  const rows: Record<string, unknown>[] = []
  let before = mem()
  for (let i = 0; i < N; i++) {
    const id = `bench-${i}`
    const [t, tConstruct] = await timed(() => createTenant(id))
    const afterConstruct = mem()
    const [, tFirst] = await timed(() => py(t, 'import numpy, pandas'))
    const afterFirst = mem()
    const [, tWarm] = await timed(() => py(t, 'print(1)'))
    const [, tPandas] = await timed(() => py(t, PANDAS))
    const after = mem()
    tenants.push(t)
    rows.push({
      tenant: id,
      'construct ms': tConstruct.toFixed(0),
      'first python ms': tFirst.toFixed(0),
      'warm ms': tWarm.toFixed(0),
      'pandas ms': tPandas.toFixed(0),
      'Δrss MB': MB(after.rss - before.rss).trim(),
      'Δarraybuf MB': MB(after.ab - before.ab).trim(),
      'Δheap MB': MB(after.heap - before.heap).trim(),
      'construct Δrss MB': MB(afterConstruct.rss - before.rss).trim(),
      'first-call Δrss MB': MB(afterFirst.rss - afterConstruct.rss).trim(),
    })
    before = after
  }
  console.log('1. sequential per-tenant setup (each row is one new Pyodide instance)')
  console.table(rows)
  console.log(`after ${N} tenants: ${fmtMem(mem())}\n`)

  // ── 2. do warm instances run python in parallel? ──
  const two = tenants.slice(0, 2)
  if (two.length === 2) {
    const [, solo] = await timed(() => py(two[0], SPIN))
    const [, both] = await timed(() => Promise.all(two.map((t) => py(t, SPIN))))
    console.log('2. CPU-bound 1s python loop')
    console.table([{ 'one tenant ms': solo.toFixed(0), 'two tenants concurrently ms': both.toFixed(0), verdict: both > solo * 1.7 ? 'SERIALIZED on the main thread' : 'parallel' }])
  }

  // ── 3. concurrent spin-up of two fresh instances ──
  {
    const b0 = mem()
    const [pair, tBoth] = await timed(() => Promise.all([createTenant('bench-par-a'), createTenant('bench-par-b')]))
    const [, tFirstBoth] = await timed(() => Promise.all(pair.map((t) => py(t, 'import numpy, pandas'))))
    const d = delta(b0, mem())
    console.log('3. two tenants spun up concurrently')
    console.table([{ 'construct both ms': tBoth.toFixed(0), 'first python both ms': tFirstBoth.toFixed(0), 'Δrss MB': MB(d.rss).trim(), 'Δarraybuf MB': MB(d.ab).trim() }])
    tenants.push(...pair)
  }

  // ── 4. bare runtime without preloaded packages, to split load time ──
  {
    const b0 = mem()
    const [ws, tC] = await timed(() => createWorkspace({ root: tenants[0].root }))
    // createWorkspace always preloads numpy+pandas; time a raw interpreter by
    // running a script that imports nothing.
    const [, tFirst] = await timed(async () => {
      const io = await ws.execute('python3 -c "print(1)"')
      if (io.exitCode !== 0) throw new Error(io.stderrText)
    })
    const d = delta(b0, mem())
    console.log('4. one more instance, first call is print(1) (numpy+pandas still preloaded at init)')
    console.table([{ 'construct ms': tC.toFixed(0), 'first python ms': tFirst.toFixed(0), 'Δrss MB': MB(d.rss).trim(), 'Δarraybuf MB': MB(d.ab).trim() }])
    await ws.close()
  }

  // ── 5. close(): time and memory returned ──
  {
    const b0 = mem()
    const [, tClose] = await timed(() => Promise.all(tenants.map((t) => t.ws.close())))
    const a = mem()
    console.log('5. close() all instances')
    console.table([{ instances: tenants.length, 'close all ms': tClose.toFixed(0), 'rss before MB': MB(b0.rss).trim(), 'rss after MB': MB(a.rss).trim(), 'arraybuf before MB': MB(b0.ab).trim(), 'arraybuf after MB': MB(a.ab).trim() }])
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
