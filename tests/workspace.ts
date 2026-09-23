// Test fixture on top of src/workspace.ts: the shared workspace with a seeded
// input CSV in RAM and a clean /out directory, plus the expected values both
// tests assert against.
import type { Workspace } from '@struktoai/mirage-node'
import { createWorkspace } from '../src/workspace.js'

export { outputExistsOnDisk, readFile, VFS_ROOT } from '../src/workspace.js'

export const SALES_CSV = `region,product,units,unit_price
north,widget,10,2.50
north,gadget,4,10.00
south,widget,6,2.50
south,gadget,1,10.00
east,widget,20,2.50
`

// Expected revenue per region = sum(units * unit_price), sorted by region.
export const EXPECTED_REVENUE: Record<string, number> = {
  east: 50.0,
  north: 65.0,
  south: 25.0,
}

// Linear system A x = b used by both tests. Exact solution is x = [2, 3].
export const LINEAR_A = [
  [3, 1],
  [1, 2],
]
export const LINEAR_B = [9, 8]
export const LINEAR_X = [2, 3]

export async function makeWorkspace(): Promise<Workspace> {
  return createWorkspace({
    // The input exists only in RAM; nothing is written to disk here.
    seed: { 'sales.csv': SALES_CSV },
    // Outputs from a previous run must never satisfy an assertion.
    clean: ['summary.csv', 'solution.json'],
  })
}

/** Parse a CSV with a header row into rows keyed by column name. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length > 0)
  const header = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim())
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
  })
}
