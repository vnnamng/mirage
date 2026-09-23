// Re-render a saved agent event log in the readable console format, without
// running the agent again.
//
//   npm run replay                       # logs/agent-events.jsonl
//   npm run replay -- path/to/other.jsonl
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Node runs this file directly with type stripping, which does not rewrite
// `.js` specifiers, so imports name the `.ts` files explicitly.
import { EventLog, type EventRecord } from '../src/event-log.ts'

const file = process.argv[2] ?? fileURLToPath(new URL('../logs/agent-events.jsonl', import.meta.url))
const records: EventRecord[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EventRecord)

console.log(`replaying ${records.length} events from ${file}\n`)
EventLog.replay(records)
