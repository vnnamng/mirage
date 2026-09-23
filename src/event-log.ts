// Event log for streamed deepagents runs.
//
// Every event is kept in memory and saved as JSONL for machines. The console
// view is meant for humans: one block per model turn, commands and outputs
// indented, timings on the right. Lifecycle entries are hidden unless verbose
// mode is on (MIRAGE_TEST_VERBOSE=1 or setVerbose(true)), but they are always
// in the JSONL file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type EventRecord = { t: number; kind: string } & Record<string, unknown>

let verbose = process.env.MIRAGE_TEST_VERBOSE === '1'
export function setVerbose(on: boolean): void {
  verbose = on
}
export function isVerbose(): boolean {
  return verbose
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const MAX_BLOCK_LINES = 30
const MAX_LINE_CHARS = 160

// ── colours ──────────────────────────────────────────────────

const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
export const dim = paint('2')
export const bold = paint('1')
export const cyan = paint('36')
export const green = paint('32')
export const red = paint('31')
export const yellow = paint('33')
export const magenta = paint('35')

// ── formatting helpers ───────────────────────────────────────

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function stamp(t: number): string {
  return dim(`+${fmtMs(t)}`.padStart(8))
}

/**
 * Indent a multi-line string as a block with a gutter, truncating long blocks.
 * `firstGutter` marks the first line differently (e.g. `$` for a command,
 * then a plain bar for its continuation lines).
 */
export function block(text: string, gutter: string, indent = '     ', firstGutter = gutter): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const shown = lines.slice(0, MAX_BLOCK_LINES).map((line, i) => {
    const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    return `${indent}${i === 0 ? firstGutter : gutter} ${clipped}`
  })
  if (lines.length > MAX_BLOCK_LINES) {
    shown.push(`${indent}${gutter} ${dim(`… ${lines.length - MAX_BLOCK_LINES} more lines`)}`)
  }
  return shown.join('\n')
}

function toText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

/** The mirage execute tool takes { command }. Other tools are shown as JSON. */
function describeInput(name: string, input: unknown): string {
  if (name === 'execute' && input && typeof input === 'object' && 'command' in input) {
    return block(String((input as { command: unknown }).command), dim('│'), '     ', cyan('$'))
  }
  return block(toText(input), cyan('>'))
}

function describeUsage(usage: unknown): string {
  if (!usage || typeof usage !== 'object') return ''
  const u = usage as Record<string, any>
  const parts = [`in ${u.input_tokens ?? '?'}`, `out ${u.output_tokens ?? '?'}`]
  const cacheRead = u.input_token_details?.cache_read
  const cacheWrite = u.input_token_details?.cache_creation
  if (cacheRead) parts.push(`cache read ${cacheRead}`)
  if (cacheWrite) parts.push(`cache write ${cacheWrite}`)
  return dim(`tokens: ${parts.join(' · ')}`)
}

// ── the log ──────────────────────────────────────────────────

export interface EventLogOptions {
  /** Print the task text under the run header. On for tests, off for chat. */
  echoTask?: boolean
}

export class EventLog {
  readonly records: EventRecord[] = []
  private readonly t0 = Date.now()
  private readonly toolStarted = new Map<string, number>()
  private readonly echoTask: boolean
  private streaming = false
  // Where the current run began, so timings and the end-of-run summary are
  // per run even when one log spans a whole chat session.
  private runStartT = 0
  private runStartIndex = 0

  constructor(options: EventLogOptions = {}) {
    this.echoTask = options.echoTask ?? true
  }

  /** Record an event and render it for the console. */
  push(kind: string, detail: Record<string, unknown> = {}): EventRecord {
    const rec: EventRecord = { t: Date.now() - this.t0, kind, ...detail }
    this.records.push(rec)
    this.endStream()
    const line = this.render(rec)
    if (line) console.log(line)
    return rec
  }

  /** Print a streamed model token inline, opening a reply line on the first one. */
  stream(token: string): void {
    if (!token) return
    if (!this.streaming) {
      process.stdout.write(`  ${magenta('reply')} `)
      this.streaming = true
    }
    process.stdout.write(token)
  }

  private endStream(): void {
    if (this.streaming) {
      process.stdout.write('\n')
      this.streaming = false
    }
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }

  ofKind(kind: string): EventRecord[] {
    return this.records.filter((r) => r.kind === kind)
  }

  /** Re-render previously saved records (from a JSONL file) to the console. */
  static replay(records: readonly EventRecord[]): void {
    const log = new EventLog()
    for (const rec of records) {
      log.records.push(rec)
      if (rec.kind === 'model.end' && rec.text) log.stream(String(rec.text))
      log.endStream()
      const line = log.render(rec)
      if (line) console.log(line)
    }
  }

  private render(rec: EventRecord): string | undefined {
    const d = rec as Record<string, any>
    const since = rec.t - this.runStartT
    switch (rec.kind) {
      case 'run.start': {
        this.runStartT = rec.t
        this.runStartIndex = this.records.length - 1
        const head = `${bold('━━ run start')}  ${dim(`model=${d.model}`)}`
        return this.echoTask ? `${head}\n${block(String(d.task ?? ''), dim('│'))}` : head
      }
      case 'run.end': {
        const inRun = this.records.slice(this.runStartIndex)
        const turns = inRun.filter((e) => e.kind === 'model.end').length
        const toolEnds = inRun.filter((e) => e.kind === 'tool.end')
        const failed = toolEnds.filter((e) => e.status !== 'finished').length
        const summary = `${turns} turns · ${toolEnds.length} tool calls${failed ? red(` · ${failed} failed`) : ''}`
        const note = d.error ? `  ${red(String(d.error))}` : ''
        return `${bold('━━ run end')}  ${dim(fmtMs(since))}  ${summary}${note}`
      }
      case 'model.start':
        return `\n${bold(`▶ turn ${d.turn}`)} ${dim(String(d.node ?? ''))}  ${stamp(since)}`
      case 'model.end': {
        const lines: string[] = []
        for (const tc of (d.toolCalls ?? []) as Array<{ name: string; args: unknown }>) {
          lines.push(`  ${yellow('call')} ${bold(tc.name)}`)
          lines.push(describeInput(tc.name, tc.args))
        }
        const usage = describeUsage(d.usage)
        if (usage) lines.push(`  ${usage}`)
        return lines.length ? lines.join('\n') : undefined
      }
      case 'tool.start':
        // The call itself was already shown under the model turn; just mark
        // when execution began so the duration on tool.end is meaningful.
        this.toolStarted.set(String(d.callId), rec.t)
        return verbose ? `  ${dim(`running ${d.name} ${d.callId}`)}  ${stamp(since)}` : undefined
      case 'tool.end': {
        const started = this.toolStarted.get(String(d.callId)) ?? rec.t
        const took = fmtMs(rec.t - started)
        const ok = d.status === 'finished'
        const head = ok
          ? `  ${green('✔')} ${bold(String(d.name))} ${dim(`finished in ${took}`)}`
          : `  ${red('✖')} ${bold(String(d.name))} ${red(String(d.status))} ${dim(`after ${took}`)}${d.error ? ` ${red(String(d.error))}` : ''}`
        const body = toText(d.output).trim()
        return body ? `${head}\n${block(body, dim('│'))}` : head
      }
      case 'lifecycle':
        return verbose
          ? `  ${dim(`· ${d.graph_name ?? ''} ${d.event ?? ''}`)}  ${stamp(since)}`
          : undefined
      case 'subagent.start':
        return `  ${magenta('subagent')} ${bold(String(d.name))} started  ${stamp(since)}`
      case 'subagent.tool':
        return `  ${magenta('subagent')} ${d.subagent} ${yellow('call')} ${bold(String(d.name))}\n${describeInput(String(d.name), d.input)}`
      case 'subagent.end':
        return `  ${magenta('subagent')} ${bold(String(d.name))} finished  ${stamp(since)}`
      default:
        return `  ${rec.kind} ${dim(JSON.stringify(d))}`
    }
  }
}
