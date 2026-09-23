// Consumes every projection of a deepagents v3 run stream and records what
// happens in an EventLog. Shared by the test and the chat CLI.
import type { EventLog } from './event-log.ts'

/** The parts of a DeepAgentRunStream this observer uses. */
export interface ObservableRun<TOutput> {
  messages: AsyncIterable<any>
  toolCalls: AsyncIterable<any>
  lifecycle: AsyncIterable<any>
  subagents: AsyncIterable<any>
  output: Promise<TOutput>
}

/**
 * Drives all projections concurrently so nothing is dropped and the log order
 * reflects when things actually happened. Resolves with the run's final state
 * once the run and every consumer have finished.
 */
export async function observeRun<TOutput>(run: ObservableRun<TOutput>, log: EventLog): Promise<TOutput> {
  const consumers = [
    // Model turns: streamed text tokens, then the turn's tool calls and usage.
    (async () => {
      let turn = 0
      for await (const msg of run.messages) {
        const index = ++turn
        log.push('model.start', { turn: index, node: msg.node })
        let text = ''
        for await (const token of msg.text) {
          text += token
          log.stream(token)
        }
        const toolCalls = await msg.toolCalls
        const usage = await msg.usage
        log.push('model.end', {
          turn: index,
          text,
          toolCalls: toolCalls.map((tc: any) => ({ id: tc.id, name: tc.name, args: tc.args })),
          usage,
        })
      }
    })(),

    // Tool calls: input when dispatched, output/status/error when settled.
    (async () => {
      for await (const call of run.toolCalls) {
        log.push('tool.start', { name: call.name, callId: call.callId, input: call.input })
        const [status, error, output] = await Promise.all([
          call.status,
          call.error,
          call.output.catch((err: unknown) => ({ rejected: String(err) })),
        ])
        log.push('tool.end', { name: call.name, callId: call.callId, status, error, output })
      }
    })(),

    // Lifecycle: node/agent start and end entries synthesized by the stream.
    (async () => {
      for await (const entry of run.lifecycle) {
        log.push('lifecycle', entry as Record<string, unknown>)
      }
    })(),

    // Subagents: none are configured in this project, but log any that appear.
    (async () => {
      for await (const sub of run.subagents) {
        log.push('subagent.start', { name: sub.name, cause: sub.cause })
        for await (const call of sub.toolCalls) {
          log.push('subagent.tool', { subagent: sub.name, name: call.name, input: call.input })
        }
        await sub.output
        log.push('subagent.end', { name: sub.name })
      }
    })(),
  ]

  const output = await run.output
  await Promise.all(consumers)
  return output
}
