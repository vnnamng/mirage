// Interactive chat with a deepagents agent whose sandbox is the mirage
// workspace: RAM /data for inputs, disk /out (vfs/) for outputs, and python3
// answered by Pyodide with numpy and pandas preloaded.
//
//   npm run chat
//   npm run chat -- --model claude-opus-5 --put data.csv --verbose
//   npm run chat -- --workspace workspaces/tenant.yaml --var TENANT_ID=alice
//
// Every turn is streamed through deepagents' v3 interface and rendered with
// the same readable event view the tests use. The whole session is saved to
// logs/chat-<timestamp>.jsonl on exit.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { ChatAnthropic } from '@langchain/anthropic'
import { MemorySaver } from '@langchain/langgraph'
import { createDeepAgent } from 'deepagents'
import { LangchainWorkspace, buildSystemPrompt } from '@struktoai/mirage-agents/langchain'
// Node runs this file directly with type stripping, which does not rewrite
// `.js` specifiers, so imports name the `.ts` files explicitly.
import { EventLog, bold, cyan, dim, isVerbose, red, setVerbose, yellow } from '../src/event-log.ts'
import { observeRun } from '../src/observe.ts'
import { MOUNT_INFO, VFS_ROOT, createWorkspace, writeText } from '../src/workspace.ts'
import { loadWorkspace } from '../src/config.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
config({ path: resolve(ROOT, '.env') })

// ── arguments ────────────────────────────────────────────────

interface Args {
  model: string
  puts: string[]
  verbose: boolean
  /** Workspace yaml; undefined = the built-in default workspace. */
  workspace?: string
  vars: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    model: process.env.MIRAGE_TEST_MODEL ?? 'claude-sonnet-5',
    puts: [],
    verbose: process.env.MIRAGE_TEST_VERBOSE === '1',
    vars: {},
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model') args.model = argv[++i] ?? args.model
    else if (a === '--put') args.puts.push(argv[++i] ?? '')
    else if (a === '--workspace' || a === '-w') args.workspace = argv[++i]
    else if (a === '--var') {
      const [k, ...rest] = (argv[++i] ?? '').split('=')
      if (!k || rest.length === 0) {
        console.error(`--var expects NAME=value\n${USAGE}`)
        process.exit(2)
      }
      args.vars[k] = rest.join('=')
    }
    else if (a === '--verbose' || a === '-v') args.verbose = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  return args
}

const USAGE = `usage: npm run chat -- [--model <id>] [--workspace <yaml>] [--var K=V]... [--put <file>]... [--verbose]

  --model <id>   Claude model id (default: MIRAGE_TEST_MODEL or claude-sonnet-5)
  --workspace <yaml>  build the workspace from a yaml file (see workspaces/)
  --var K=V      value for a \${K} reference in the yaml (repeatable)
  --put <file>   copy a host text file into /data before the chat starts
  --verbose      also show lifecycle events`

const HELP = `${bold('commands')}
  /help              this list
  /put <file> [name] copy a host text file into /data (name defaults to the file's name)
  /sh <command>      run a shell command in the workspace, e.g. /sh ls /data /out
  /ls                list /data and /out
  /verbose           toggle lifecycle events in the trace
  /reset             forget the conversation and start a new thread
  /exit              quit (also Ctrl+D). Ctrl+C interrupts a running turn.
anything else is sent to the agent.`

// ── main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  setVerbose(args.verbose)

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(red('ANTHROPIC_API_KEY is not set (export it or put it in .env)'))
    process.exit(1)
  }

  let ws: Awaited<ReturnType<typeof createWorkspace>>
  let mountInfo: Record<string, string> = MOUNT_INFO
  let outRoot = VFS_ROOT
  if (args.workspace) {
    console.log(dim(`starting workspace from ${args.workspace}…`))
    const built = await loadWorkspace(args.workspace, { vars: args.vars })
    ws = built.ws
    mountInfo = built.mountInfo
    outRoot = built.diskRoots['/out'] ?? Object.values(built.diskRoots)[0] ?? '(no disk mount)'
  } else {
    console.log(dim('starting workspace (pyodide + numpy + pandas)…'))
    ws = await createWorkspace()
  }
  for (const file of args.puts) await put(ws, file)

  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
  const agent = createDeepAgent({
    model: new ChatAnthropic({
      model: args.model,
      maxTokens: 16_000,
      clientOptions: workspaceId
        ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } }
        : undefined,
    }),
    systemPrompt: buildSystemPrompt({ mountInfo }),
    backend: new LangchainWorkspace(ws),
    // Keeps the conversation across turns; /reset starts a new thread.
    checkpointer: new MemorySaver(),
  })

  let threadId = randomUUID()
  const log = new EventLog({ echoTask: false })
  const logFile = resolve(ROOT, 'logs', `chat-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  let active: AbortController | undefined

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  rl.on('SIGINT', () => {
    if (active) {
      active.abort('interrupted by user')
      console.log(`\n${yellow('interrupting…')}`)
    } else {
      rl.close()
    }
  })
  const input = new LineQueue(rl)

  console.log(`${bold('mirage chat')}  ${dim(`model=${args.model}  mounts=${Object.keys(mountInfo).join(',')}  out=${outRoot}`)}`)
  console.log(HELP)

  const shutdown = async () => {
    if (log.records.length > 0) {
      log.save(logFile)
      console.log(dim(`session log written to ${logFile}`))
    }
    await ws.close()
  }

  try {
    for (;;) {
      process.stdout.write(`\n${cyan('you>')} `)
      const raw = await input.next()
      if (raw === null) break // stdin closed (Ctrl+D or end of piped input)
      const line = raw.trim()
      // Echo piped input so a transcript shows the question with its answer.
      if (!process.stdin.isTTY) process.stdout.write(`${line}\n`)
      if (!line) continue

      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.split(/\s+/)
        const arg = line.slice(cmd.length).trim()
        if (cmd === '/exit' || cmd === '/quit') break
        if (cmd === '/help') console.log(HELP)
        else if (cmd === '/reset') {
          threadId = randomUUID()
          console.log(dim('conversation reset'))
        } else if (cmd === '/verbose') {
          setVerbose(!isVerbose())
          console.log(dim(`verbose ${isVerbose() ? 'on' : 'off'}`))
        } else if (cmd === '/ls') await sh(ws, 'ls /data; echo ---; ls /out')
        else if (cmd === '/sh') await sh(ws, arg)
        else if (cmd === '/put') await put(ws, rest[0] ?? '', rest[1])
        else console.log(red(`unknown command ${cmd}`), dim('(try /help)'))
        continue
      }

      active = new AbortController()
      log.push('run.start', { model: args.model, task: line, threadId })
      try {
        const run = await agent.streamEvents(
          { messages: [{ role: 'user', content: line }] },
          { version: 'v3', configurable: { thread_id: threadId }, signal: active.signal },
        )
        await observeRun(run, log)
        log.push('run.end', { events: log.records.length })
      } catch (err) {
        const message = active.signal.aborted ? 'interrupted' : String((err as Error)?.message ?? err)
        log.push('run.end', { events: log.records.length, error: message })
      } finally {
        active = undefined
      }
    }
  } finally {
    rl.close()
    await shutdown()
  }
}

// ── helpers ──────────────────────────────────────────────────

/**
 * Buffers readline's 'line' events so input typed (or piped) while a turn is
 * running is queued rather than dropped, which `rl.question()` would do.
 */
class LineQueue {
  private readonly queue: string[] = []
  private waiter: ((line: string | null) => void) | undefined
  private closed = false

  constructor(rl: ReturnType<typeof createInterface>) {
    rl.on('line', (line) => {
      if (this.waiter) {
        const resolve = this.waiter
        this.waiter = undefined
        resolve(line)
      } else {
        this.queue.push(line)
      }
    })
    rl.on('close', () => {
      this.closed = true
      if (this.waiter) {
        const resolve = this.waiter
        this.waiter = undefined
        resolve(null)
      }
    })
  }

  /** Next line, or null once input is closed and the queue is drained. */
  next(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }
}

async function sh(ws: Awaited<ReturnType<typeof createWorkspace>>, command: string): Promise<void> {
  if (!command) {
    console.log(red('usage: /sh <command>'))
    return
  }
  const io = await ws.execute(command)
  if (io.stdoutText) process.stdout.write(io.stdoutText.endsWith('\n') ? io.stdoutText : `${io.stdoutText}\n`)
  if (io.stderrText) process.stderr.write(red(io.stderrText.endsWith('\n') ? io.stderrText : `${io.stderrText}\n`))
  if (io.exitCode !== 0) console.log(dim(`exit ${io.exitCode}`))
}

async function put(ws: Awaited<ReturnType<typeof createWorkspace>>, file: string, name?: string): Promise<void> {
  if (!file) {
    console.log(red('usage: /put <host file> [name]'))
    return
  }
  const host = resolve(file)
  if (!existsSync(host)) {
    console.log(red(`no such file: ${host}`))
    return
  }
  const target = `/data/${name ?? basename(host)}`
  await writeText(ws, target, readFileSync(host, 'utf8'))
  console.log(dim(`copied ${host} → ${target}`))
}

main().catch((err) => {
  console.error(red(String(err?.stack ?? err)))
  process.exit(1)
})
