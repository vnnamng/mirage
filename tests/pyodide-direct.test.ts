// Direct (no LLM) test of the mirage RAM VFS + Pyodide runtime.
// Proves numpy (linear algebra) and pandas (read_csv) run inside Pyodide
// against files that live in the in-memory mount.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@struktoai/mirage-node'
import {
  EXPECTED_REVENUE,
  LINEAR_A,
  LINEAR_B,
  LINEAR_X,
  makeWorkspace,
  outputExistsOnDisk,
  parseCsv,
  readFile,
} from './workspace.js'

let ws: Workspace

beforeAll(async () => {
  ws = await makeWorkspace()
})

afterAll(async () => {
  await ws?.close()
})

async function runPython(script: string) {
  // Write the script into the VFS and run it, so the test also covers
  // python3 reading its entry file from the RAM mount.
  const write = await ws.execute(`cat > /data/script.py <<'PY'\n${script}\nPY\n`)
  expect(write.exitCode, write.stderrText).toBe(0)
  const io = await ws.execute('python3 /data/script.py')
  return { stdout: io.stdoutText, stderr: io.stderrText, exitCode: io.exitCode }
}

describe('pyodide runtime on a RAM VFS', () => {
  it('runs python3 at all and sees both mounts', async () => {
    const io = await ws.execute(
      `python3 -c "import sys, os; print(sys.version.split()[0]); print(sorted(os.listdir('/data'))); print(os.path.isdir('/out'))"`,
    )
    expect(io.exitCode, io.stderrText).toBe(0)
    expect(io.stdoutText).toMatch(/^3\.\d+/)
    expect(io.stdoutText).toContain('sales.csv')
    expect(io.stdoutText).toContain('True')
    // The input exists only in RAM, never on the host disk.
    expect(outputExistsOnDisk('sales.csv')).toBe(false)
  })

  it('numpy: solves a linear system, inverts, and checks eigenvalues', async () => {
    const { stdout, stderr, exitCode } = await runPython(`
import json
import numpy as np

A = np.array(${JSON.stringify(LINEAR_A)}, dtype=float)
b = np.array(${JSON.stringify(LINEAR_B)}, dtype=float)

x = np.linalg.solve(A, b)
residual = float(np.linalg.norm(A @ x - b))
inv = np.linalg.inv(A)
identity_ok = bool(np.allclose(inv @ A, np.eye(2)))
det = float(np.linalg.det(A))
eig = sorted(float(v) for v in np.linalg.eigvals(A))

result = {
    "numpy": np.__version__,
    "x": x.tolist(),
    "residual": residual,
    "identity_ok": identity_ok,
    "det": det,
    "eig": eig,
}
with open("/out/solution.json", "w") as f:
    json.dump(result, f)
print(json.dumps(result))
`)
    expect(exitCode, stderr).toBe(0)
    const out = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(out.numpy).toMatch(/^\d+\.\d+/)
    // The result was persisted through the disk mount.
    expect(outputExistsOnDisk('solution.json')).toBe(true)
    expect(JSON.parse(await readFile(ws, '/out/solution.json'))).toEqual(out)
    expect(out.x[0]).toBeCloseTo(LINEAR_X[0], 9)
    expect(out.x[1]).toBeCloseTo(LINEAR_X[1], 9)
    expect(out.residual).toBeLessThan(1e-9)
    expect(out.identity_ok).toBe(true)
    expect(out.det).toBeCloseTo(5, 9)
    // eigenvalues of [[3,1],[1,2]] are (5 ± sqrt(5)) / 2
    expect(out.eig[0]).toBeCloseTo((5 - Math.sqrt(5)) / 2, 9)
    expect(out.eig[1]).toBeCloseTo((5 + Math.sqrt(5)) / 2, 9)
  })

  it('pandas: reads a CSV from the RAM mount, aggregates, and writes back', async () => {
    const { stdout, stderr, exitCode } = await runPython(`
import json
import pandas as pd

df = pd.read_csv("/data/sales.csv")
df["revenue"] = df["units"] * df["unit_price"]
summary = df.groupby("region", as_index=False)["revenue"].sum().sort_values("region")
summary.to_csv("/out/summary.csv", index=False)

print(json.dumps({
    "pandas": pd.__version__,
    "rows": int(len(df)),
    "columns": list(df.columns),
    "revenue": {r: float(v) for r, v in zip(summary["region"], summary["revenue"])},
}))
`)
    expect(exitCode, stderr).toBe(0)
    const out = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(out.pandas).toMatch(/^\d+\.\d+/)
    expect(out.rows).toBe(5)
    expect(out.columns).toEqual(['region', 'product', 'units', 'unit_price', 'revenue'])
    expect(out.revenue).toEqual(EXPECTED_REVENUE)

    // The file pandas wrote must have been flushed through the disk mount to
    // the host filesystem, where shell tools (and the host) can read it.
    expect(outputExistsOnDisk('summary.csv')).toBe(true)
    const rows = parseCsv(await readFile(ws, '/out/summary.csv'))
    expect(rows.map((r) => r.region)).toEqual(['east', 'north', 'south'])
    for (const row of rows) {
      expect(Number(row.revenue)).toBeCloseTo(EXPECTED_REVENUE[row.region], 6)
    }
  })
})
