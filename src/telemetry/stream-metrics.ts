import type { AssistantMessageEvent, AssistantMessageEventStream } from '@mariozechner/pi-ai'
import type { Span } from '@opentelemetry/api'

import { buildResponseCaptureAttr, type CaptureOpts } from './capture'
import type { Tel } from './tel'

// Re-emits every event from `upstream` while recording TTFT on first text chunk
// and completion attrs on done. Costs are per-token rates supplied by the caller.
// If `capture` is provided AND `capture.capturePrompts` is true, the done event's
// message content is serialized onto the span as `gen_ai.output.messages`.
export const wrapStreamForMetrics = async function* (
  upstream: AssistantMessageEventStream,
  span: Span,
  tel: Tel,
  costs: { inputCost: number; outputCost: number },
  capture?: CaptureOpts
): AsyncIterable<AssistantMessageEvent> {
  const start = Date.now()
  let firstChunk: number | undefined
  let lastChunk: number | undefined
  for await (const event of upstream) {
    if (
      (event.type === 'text_delta' ||
        event.type === 'text_start' ||
        event.type === 'thinking_delta' ||
        event.type === 'thinking_start') &&
      firstChunk === undefined
    ) {
      firstChunk = Date.now()
      if (event.type === 'text_delta' || event.type === 'text_start') {
        tel.recordTTFT(span, firstChunk - start)
      }
    }
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      lastChunk = Date.now()
    }
    if (event.type === 'done') {
      try {
        const endChunk = lastChunk ?? Date.now()
        const startChunk = firstChunk ?? endChunk
        const elapsedSec = Math.max(0.001, (endChunk - startChunk) / 1000)
        const usage = event.message.usage
        const cost = usage.input * costs.inputCost + usage.output * costs.outputCost
        const tps = usage.output === 0 ? 0 : usage.output / elapsedSec
        tel.recordCompletion(span, usage, cost, tps)
        if (capture !== undefined) {
          const attrs = buildResponseCaptureAttr(capture, event.message)
          if (Object.keys(attrs).length > 0) span.setAttributes(attrs)
        }
      } catch {
        // Telemetry must not break the data path. Span will end without completion attrs.
      }
    }
    yield event
  }
}
