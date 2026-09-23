// End-to-end: a deepagents agent on the Anthropic API uses the mirage
// workspace (RAM /data for inputs, disk /out for outputs, Pyodide runtime)
// as its sandbox backend and must do real numpy linear algebra and a pandas
// read_csv, writing results into /out.
//
// The agent is driven through deepagents' v3 streaming interface
// (`agent.streamEvents(..., { version: 'v3' })`) and every event it surfaces
// is logged: model turns with streamed text, tool calls with input and
// output, lifecycle entries, and subagent runs. The console shows a
// human-readable view (set MIRAGE_TEST_VERBOSE=1 to include lifecycle
// entries); the complete log goes to logs/agent-events.jsonl.
//
// Requires ANTHROPIC_API_KEY (shell env or .env). Skipped otherwise.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Workspace } from '@struktoai/mirage-node'
import { ChatAnthropic } from '@langchain/anthropic'
import { createDeepAgent } from 'deepagents'
import {
  LangchainWorkspace,
  buildSystemPrompt,
  extractText,
} from '@struktoai/mirage-agents/langchain'
import { EventLog } from '../src/event-log.js'
import { observeRun } from '../src/observe.js'
import { MOUNT_INFO } from '../src/workspace.js'
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

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.MIRAGE_TEST_MODEL ?? 'claude-sonnet-5'
// Organization-level API keys (not scoped to a workspace) are rejected by the
// API unless every request carries the workspace to bill. Workspace-scoped
// keys do not need this.
const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID
const LOG_FILE = fileURLToPath(new URL('../logs/agent-events.jsonl', import.meta.url))

let ws: Workspace

beforeAll(async () => {
  if (!API_KEY) return
  ws = await makeWorkspace()
})

afterAll(async () => {
  await ws?.close()
})

describe.skipIf(!API_KEY)('deepagents + mirage (RAM /data, disk /out, pyodide), streamed', () => {
  it('agent uses numpy for linear algebra and pandas to read a CSV', async () => {
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: MODEL,
        maxTokens: 16_000,
        clientOptions: WORKSPACE_ID
          ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE_ID } }
          : undefined,
      }),
      systemPrompt: buildSystemPrompt({ mountInfo: MOUNT_INFO }),
      backend: new LangchainWorkspace(ws),
    })

    const task = `
Do the following using the execute tool to run python3 (numpy and pandas are
installed). Do not compute anything by hand. Inputs are under /data; write all
outputs under /out.

1. With numpy, solve the linear system A x = b where
   A = ${JSON.stringify(LINEAR_A)} and b = ${JSON.stringify(LINEAR_B)}.
   Write the result to /out/solution.json as a JSON object with keys:
   "x" (list of 2 floats), "det" (float determinant of A), "numpy_version" (string).

2. With pandas, read /data/sales.csv (columns: region,product,units,unit_price).
   Compute revenue = units * unit_price, sum it per region, sort by region,
   and write /out/summary.csv with exactly two columns: region,revenue (no index).

3. Reply with one line: "DONE numpy=<version> pandas=<version>".
`.trim()

    const log = new EventLog()
    log.push('run.start', { model: MODEL, task })

    const run = await agent.streamEvents(
      { messages: [{ role: 'user', content: task }] },
      { version: 'v3' },
    )

    let output: Awaited<typeof run.output>
    try {
      output = await observeRun(run, log)
    } finally {
      log.push('run.end', { events: log.records.length })
      log.save(LOG_FILE)
      console.log(`event log written to ${LOG_FILE}`)
    }

    // ── assertions on what was streamed ──
    const toolStarts = log.ofKind('tool.start')
    const toolEnds = log.ofKind('tool.end')
    expect(toolStarts.length).toBeGreaterThan(0)
    expect(toolEnds.length).toBe(toolStarts.length)
    expect(toolEnds.every((e) => e.status === 'finished')).toBe(true)
    // At least one tool call ran python inside the mirage sandbox.
    expect(toolStarts.some((e) => /python/.test(JSON.stringify(e.input)))).toBe(true)
    // Model turns were observed, and the last one carried the final reply.
    const modelEnds = log.ofKind('model.end')
    expect(modelEnds.length).toBeGreaterThan(0)
    expect(String(modelEnds.at(-1)!.text)).toMatch(/DONE numpy=\d+\.\d+\S* pandas=\d+\.\d+\S*/)

    // ── assertions on the final state ──
    const finalText = extractText(output.messages.slice(-1)).join('\n')
    expect(finalText).toMatch(/DONE numpy=\d+\.\d+\S* pandas=\d+\.\d+\S*/)

    // Outputs were persisted through the disk mount to vfs/ on the host.
    expect(outputExistsOnDisk('solution.json')).toBe(true)
    expect(outputExistsOnDisk('summary.csv')).toBe(true)
    // The input never left RAM.
    expect(outputExistsOnDisk('sales.csv')).toBe(false)

    // numpy artifact
    const solution = JSON.parse(await readFile(ws, '/out/solution.json'))
    expect(solution.x).toHaveLength(2)
    expect(solution.x[0]).toBeCloseTo(LINEAR_X[0], 6)
    expect(solution.x[1]).toBeCloseTo(LINEAR_X[1], 6)
    expect(solution.det).toBeCloseTo(5, 6)
    expect(solution.numpy_version).toMatch(/^\d+\.\d+/)

    // pandas artifact
    const rows = parseCsv(await readFile(ws, '/out/summary.csv'))
    expect(rows.map((r) => r.region)).toEqual(['east', 'north', 'south'])
    for (const row of rows) {
      expect(Number(row.revenue)).toBeCloseTo(EXPECTED_REVENUE[row.region], 6)
    }
  })
})
