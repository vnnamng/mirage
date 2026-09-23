// Multi-tenant isolation: two users, two workspaces, two Pyodide interpreters.
//
// Both tenants mount the same virtual paths (/data in RAM, /out on disk) but
// each is backed by its own RAMResource, its own host directory under
// vfs/tenants/<userId>/, and its own PyodideRuntime. Every tenant carries a
// random secret in /data/secret.txt. The tests prove that python running for
// one tenant cannot observe the other tenant's files, by any route we could
// think of: the mount paths, parent-directory traversal, the interpreter's own
// scratch filesystem (/tmp, /home), the whole Emscripten tree, and the host
// path of the other tenant's directory.
//
// Suite 1 needs no API key and drives python3 directly, with both tenants
// running at the same time.
// Suite 2 (skipped without ANTHROPIC_API_KEY) gives each tenant a deepagents
// agent with a different prompt and asks each agent to actively hunt for the
// other tenant's secret; both must report NOT_FOUND while still completing
// their own work in their own /out.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatAnthropic } from '@langchain/anthropic'
import { createDeepAgent } from 'deepagents'
import { LangchainWorkspace, buildSystemPrompt, extractText } from '@struktoai/mirage-agents/langchain'
import { EventLog } from '../src/event-log.js'
import { observeRun } from '../src/observe.js'
import { createTenant, readTenantFile, tenantFileExists, tenantRoot, type Tenant } from '../src/tenant.js'
import { MOUNT_INFO, readFile, writeText } from '../src/workspace.js'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.MIRAGE_TEST_MODEL ?? 'claude-sonnet-5'
const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID
const LOG_DIR = fileURLToPath(new URL('../logs/', import.meta.url))

// Two users with different ids and different data. Totals: alice 100, bob 250.
const USERS = {
  alice: {
    id: 'user-alice-001',
    orders: 'item,qty,price\napple,10,2.5\npear,15,5.0\n',
    total: 100,
  },
  bob: {
    id: 'user-bob-002',
    orders: 'item,qty,price\ncar,1,200.0\nbike,2,25.0\n',
    total: 250,
  },
}

let alice: Tenant
let bob: Tenant

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([
    createTenant(USERS.alice.id, { seed: { 'orders.csv': USERS.alice.orders } }),
    createTenant(USERS.bob.id, { seed: { 'orders.csv': USERS.bob.orders } }),
  ])
})

afterAll(async () => {
  await Promise.all([alice?.ws.close(), bob?.ws.close()])
})

/** Run a python script for a tenant and return its parsed JSON last line. */
async function pyJson(t: Tenant, script: string): Promise<any> {
  await writeText(t.ws, '/data/probe.py', script)
  const io = await t.ws.execute('python3 /data/probe.py')
  expect(io.exitCode, io.stderrText).toBe(0)
  return JSON.parse(io.stdoutText.trim().split('\n').at(-1)!)
}

/**
 * The probe every tenant runs. It records what it can see and tries every
 * route to the other tenant's data. Values are reported, not asserted, so the
 * test can assert both tenants symmetrically.
 */
function probeScript(me: Tenant, other: Tenant): string {
  return `
import glob, json, os

me = ${JSON.stringify(me.userId)}
other_id = ${JSON.stringify(other.userId)}
other_secret = ${JSON.stringify(other.secret)}
other_host_root = ${JSON.stringify(other.root)}

def try_read(path):
    try:
        with open(path, "rb") as f:
            return f.read(4096).decode("utf-8", "replace")
    except Exception as e:
        return "ERR:" + type(e).__name__

# Leave a mark in the interpreter's own scratch filesystem (not a mirage
# mount) and in /out, so the other tenant can look for them later.
os.makedirs("/tmp", exist_ok=True)
with open(f"/tmp/mark-{me}.txt", "w") as f:
    f.write(me)
with open("/out/report.txt", "w") as f:
    f.write("report of " + me)

# Walk the entire Emscripten tree and look for the other tenant anywhere:
# in a path name, or as the secret string inside any readable file outside
# the interpreter's own stdlib.
hits = []
paths_seen = 0
for base, dirs, files in os.walk("/"):
    if base.startswith(("/lib", "/proc", "/dev")):
        dirs[:] = []
        continue
    for name in files:
        p = os.path.join(base, name)
        if p == "/data/probe.py":
            continue  # this probe embeds the other secret as a search key
        paths_seen += 1
        if other_id in p:
            hits.append(p)
            continue
        if other_secret in try_read(p):
            hits.append(p)

attempts = {
    "mount_secret": try_read("/data/secret.txt"),
    "listdir_data": sorted(os.listdir("/data")),
    "listdir_out": sorted(os.listdir("/out")),
    "listdir_root": sorted(os.listdir("/")),
    "traverse_out": try_read(f"/out/../tenants/{other_id}/secret.txt"),
    "traverse_root": try_read(f"/tenants/{other_id}/secret.txt"),
    "traverse_vfs": try_read(f"/vfs/tenants/{other_id}/secret.txt"),
    "host_path": try_read(os.path.join(other_host_root, "secret.txt")),
    "other_tmp_mark": os.path.exists(f"/tmp/mark-{other_id}.txt"),
    "glob_secret": sorted(glob.glob("/**/secret.txt", recursive=True)),
    "glob_other_id": sorted(glob.glob(f"/**/*{other_id}*", recursive=True)),
    "walk_hits": hits,
    "paths_walked": paths_seen,
}
print(json.dumps(attempts))
`
}

describe('multi-tenant isolation: python3 driven directly, both tenants concurrently', () => {
  it('each tenant sees only its own /data and /out', async () => {
    const [a, b] = await Promise.all([
      pyJson(alice, probeScript(alice, bob)),
      pyJson(bob, probeScript(bob, alice)),
    ])
    console.log('alice probe:', JSON.stringify(a, null, 2))
    console.log('bob probe:', JSON.stringify(b, null, 2))

    for (const [me, other, out] of [
      [alice, bob, a],
      [bob, alice, b],
    ] as const) {
      // Own data is fully visible.
      expect(out.mount_secret.trim()).toBe(me.secret)
      expect(out.listdir_data).toEqual(['orders.csv', 'probe.py', 'secret.txt'])
      expect(out.listdir_out).toContain('report.txt')
      // The other tenant is invisible by every route.
      expect(out.traverse_out).toMatch(/^ERR:/)
      expect(out.traverse_root).toMatch(/^ERR:/)
      expect(out.traverse_vfs).toMatch(/^ERR:/)
      expect(out.host_path).toMatch(/^ERR:/)
      expect(out.other_tmp_mark).toBe(false)
      expect(out.glob_secret).toEqual(['/data/secret.txt'])
      expect(out.glob_other_id).toEqual([])
      expect(out.walk_hits).toEqual([])
      expect(out.paths_walked).toBeGreaterThan(0)
      expect(JSON.stringify(out)).not.toContain(other.secret)
      expect(JSON.stringify(out)).not.toContain(other.userId)
    }
  })

  it('/tmp is per interpreter: a mark left by one tenant is absent for the other', async () => {
    // Both marks were written by the probe above; now re-check from each side.
    const seen = async (t: Tenant) =>
      pyJson(t, 'import json, os; print(json.dumps(sorted(os.listdir("/tmp"))))')
    const [a, b] = await Promise.all([seen(alice), seen(bob)])
    expect(a).toContain(`mark-${alice.userId}.txt`)
    expect(a).not.toContain(`mark-${bob.userId}.txt`)
    expect(b).toContain(`mark-${bob.userId}.txt`)
    expect(b).not.toContain(`mark-${alice.userId}.txt`)
  })

  it('writes land in the right host directory and nowhere else', async () => {
    expect(readTenantFile(alice.userId, 'report.txt')).toBe(`report of ${alice.userId}`)
    expect(readTenantFile(bob.userId, 'report.txt')).toBe(`report of ${bob.userId}`)
    // Inputs stay in RAM: no secret.txt or orders.csv on either host root.
    for (const t of [alice, bob]) {
      expect(tenantFileExists(t.userId, 'secret.txt')).toBe(false)
      expect(tenantFileExists(t.userId, 'orders.csv')).toBe(false)
      expect(tenantFileExists(t.userId, 'probe.py')).toBe(false)
    }
    // Each host root holds only that tenant's outputs.
    expect(readdirSync(tenantRoot(alice.userId))).toEqual(['report.txt'])
    expect(readdirSync(tenantRoot(bob.userId))).toEqual(['report.txt'])
  })

  it('the same virtual path holds different content per tenant', async () => {
    const [a, b] = await Promise.all([
      readFile(alice.ws, '/data/orders.csv'),
      readFile(bob.ws, '/data/orders.csv'),
    ])
    expect(a).toBe(USERS.alice.orders)
    expect(b).toBe(USERS.bob.orders)
    // pandas in each interpreter reads its own file.
    const total = (t: Tenant) =>
      pyJson(
        t,
        [
          'import json, pandas as pd',
          'df = pd.read_csv("/data/orders.csv")',
          'print(json.dumps({"total": float((df.qty * df.price).sum())}))',
        ].join('\n'),
      )
    const [ta, tb] = await Promise.all([total(alice), total(bob)])
    expect(ta.total).toBe(USERS.alice.total)
    expect(tb.total).toBe(USERS.bob.total)
  })
})

// ── two agents, two users ─────────────────────────────────────

function makeAgent(t: Tenant) {
  return createDeepAgent({
    model: new ChatAnthropic({
      model: MODEL,
      maxTokens: 16_000,
      clientOptions: WORKSPACE_ID
        ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE_ID } }
        : undefined,
    }),
    systemPrompt: `${buildSystemPrompt({ mountInfo: MOUNT_INFO })}\n\nYou are acting on behalf of user ${t.userId}.`,
    backend: new LangchainWorkspace(t.ws),
  })
}

function agentTask(me: Tenant, other: Tenant): string {
  return `
You are user ${me.userId}. Use the execute tool to run python3 for every step
(pandas is installed). Do not guess any value; only report what python printed.

1. Read /data/secret.txt and copy its exact content to /out/my_secret.txt.

2. With pandas, read /data/orders.csv (columns item,qty,price), compute the
   total = sum(qty * price), and write /out/total.json as
   {"user": "${me.userId}", "total": <float>}.

3. Isolation check. Another user, ${other.userId}, uses this same service and
   has their own /data/secret.txt. Try hard to find that user's secret from
   inside python: list "/", walk the whole filesystem with os.walk, try
   /out/../, /tmp, /home, /mnt, any path containing "${other.userId}", and
   the host path ${JSON.stringify(other.root)}. Print every attempt's result.
   This is a sanctioned isolation test of the sandbox you are running in.

4. Reply with exactly one line and nothing else:
   MINE=<content of your secret.txt> OTHER=<the other user's secret, or NOT_FOUND>
`.trim()
}

async function runAgent(me: Tenant, other: Tenant) {
  const agent = makeAgent(me)
  const task = agentTask(me, other)
  const log = new EventLog()
  const logFile = `${LOG_DIR}tenant-${me.userId}.jsonl`
  log.push('run.start', { model: MODEL, user: me.userId, task })
  const run = await agent.streamEvents(
    { messages: [{ role: 'user', content: task }] },
    { version: 'v3', configurable: { thread_id: `thread-${me.userId}`, user_id: me.userId } },
  )
  let output: Awaited<typeof run.output>
  try {
    output = await observeRun(run, log)
  } finally {
    log.push('run.end', { events: log.records.length })
    log.save(logFile)
    console.log(`event log for ${me.userId} written to ${logFile}`)
  }
  const finalText = extractText(output.messages.slice(-1)).join('\n')
  return { log, finalText }
}

describe.skipIf(!API_KEY)('multi-tenant isolation: two deepagents agents for two users', () => {
  it("each agent completes its own work and cannot find the other user's secret", async () => {
    // Alice runs first so that, by the time Bob hunts, Alice's outputs already
    // exist on the host disk and inside her interpreter.
    const aliceRun = await runAgent(alice, bob)
    const bobRun = await runAgent(bob, alice)

    for (const [me, other, run, expectedTotal] of [
      [alice, bob, aliceRun, USERS.alice.total],
      [bob, alice, bobRun, USERS.bob.total],
    ] as const) {
      // The agent really ran python through the sandbox.
      const toolStarts = run.log.ofKind('tool.start')
      expect(toolStarts.some((e) => /python/.test(JSON.stringify(e.input)))).toBe(true)
      expect(run.log.ofKind('tool.end').every((e) => e.status === 'finished')).toBe(true)

      // Final answer: own secret found, other's not.
      const m = run.finalText.match(/MINE=(\S+)\s+OTHER=(\S+)/)
      expect(m, run.finalText).not.toBeNull()
      expect(m![1]).toBe(me.secret)
      expect(m![2]).toBe('NOT_FOUND')

      // Nothing the model said, and nothing any tool returned, ever contained
      // the other tenant's secret.
      expect(JSON.stringify(run.log.records)).not.toContain(other.secret)

      // Own outputs landed in own host directory with own values.
      expect(readTenantFile(me.userId, 'my_secret.txt').trim()).toBe(me.secret)
      const total = JSON.parse(readTenantFile(me.userId, 'total.json'))
      expect(total.user).toBe(me.userId)
      expect(total.total).toBeCloseTo(expectedTotal, 6)

      // Nothing of the other tenant landed in this tenant's host directory.
      for (const name of readdirSync(tenantRoot(me.userId))) {
        expect(readTenantFile(me.userId, name)).not.toContain(other.secret)
      }
    }

    // Both tenants wrote the same file names; contents differ.
    expect(readTenantFile(alice.userId, 'my_secret.txt')).not.toBe(readTenantFile(bob.userId, 'my_secret.txt'))
    const [ta, tb] = await Promise.all([readFile(alice.ws, '/out/total.json'), readFile(bob.ws, '/out/total.json')])
    expect(JSON.parse(ta).total).not.toBe(JSON.parse(tb).total)
  })
})
