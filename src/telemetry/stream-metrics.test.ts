import { describe, expect, it } from 'bun:test'

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

import { wrapStreamForMetrics } from './stream-metrics'
import { createTel } from './tel'
import { useTestExporter } from './test-fixture'

const drain = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

const makeDoneEvent = (input: number, output: number) => ({
  type: 'done' as const,
  reason: 'stop' as const,
  message: {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'h' }],
    api: 'openai-completions' as const,
    provider: 'test',
    model: 'm',
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop' as const,
    timestamp: Date.now()
  }
})

describe('wrapStreamForMetrics', () => {
  const exporter = useTestExporter()

  it('records TTFT on first text_delta and completion on done', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const upstream = createAssistantMessageEventStream()
      const wrapped = wrapStreamForMetrics(upstream, span, tel, {
        inputCost: 0.000001,
        outputCost: 0.000002
      })
      queueMicrotask(() => {
        upstream.push({ type: 'text_delta', delta: 'h' } as never)
        upstream.push(makeDoneEvent(100, 50) as never)
      })
      await drain(wrapped)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    if (!attrs) throw new Error('missing finished span attributes')
    expect(attrs['pi.time_to_first_token_ms']).toBeGreaterThanOrEqual(0)
    expect(attrs?.['gen_ai.usage.input_tokens']).toBe(100)
    expect(attrs?.['gen_ai.usage.output_tokens']).toBe(50)
    expect(attrs?.['gen_ai.usage.cost_usd']).toBeCloseTo(100 * 0.000001 + 50 * 0.000002)
    expect(typeof attrs?.['pi.output_tokens_per_second']).toBe('number')
  })

  it('passes through every upstream event unchanged', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const upstream = createAssistantMessageEventStream()
      const wrapped = wrapStreamForMetrics(upstream, span, tel, { inputCost: 0, outputCost: 0 })
      queueMicrotask(() => {
        upstream.push({ type: 'text_delta', delta: 'a' } as never)
        upstream.push({ type: 'text_delta', delta: 'b' } as never)
        upstream.push(makeDoneEvent(1, 2) as never)
      })
      const events = await drain(wrapped)
      expect(events.length).toBe(3)
      expect((events[0] as { type: string }).type).toBe('text_delta')
      expect((events[2] as { type: string }).type).toBe('done')
    })
  })

  it('treats text_start as the first chunk for TTFT timing', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const upstream = createAssistantMessageEventStream()
      const wrapped = wrapStreamForMetrics(upstream, span, tel, { inputCost: 0, outputCost: 0 })
      queueMicrotask(() => {
        upstream.push({ type: 'text_start' } as never)
        upstream.push({ type: 'text_delta', delta: 'x' } as never)
        upstream.push(makeDoneEvent(1, 1) as never)
      })
      await drain(wrapped)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    expect(attrs?.['pi.time_to_first_token_ms']).toBeGreaterThanOrEqual(0)
  })

  it('records 0 tokens/sec when no text chunks before done', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const upstream = createAssistantMessageEventStream()
      const wrapped = wrapStreamForMetrics(upstream, span, tel, { inputCost: 0, outputCost: 0 })
      queueMicrotask(() => {
        upstream.push(makeDoneEvent(10, 0) as never)
      })
      await drain(wrapped)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    if (!attrs) throw new Error('missing finished span attributes')
    // output is 0 so tps must be 0 (or finite, not NaN/Infinity)
    expect(Number.isFinite(attrs['pi.output_tokens_per_second'] as number)).toBe(true)
    expect(attrs['pi.output_tokens_per_second']).toBe(0)
  })

  it('updates lastChunk on thinking_delta so reasoning-only streams record tps', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const upstream = createAssistantMessageEventStream()
      const wrapped = wrapStreamForMetrics(upstream, span, tel, { inputCost: 0, outputCost: 0 })
      queueMicrotask(async () => {
        upstream.push({ type: 'thinking_delta', delta: 'one' } as never)
        // Sleep so the elapsed window between firstChunk and lastChunk is non-trivial.
        await Bun.sleep(10)
        upstream.push({ type: 'thinking_delta', delta: 'two' } as never)
        upstream.push(makeDoneEvent(5, 50) as never)
      })
      await drain(wrapped)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    if (!attrs) throw new Error('missing finished span attributes')
    const tps = attrs['pi.output_tokens_per_second'] as number
    // 50 output tokens / >=10ms elapsed ≈ <5000 tps. If lastChunk were never updated,
    // elapsed would fall through to Math.max(0.001, 0) and tps = 50000.
    expect(tps).toBeLessThan(10_000)
    expect(tps).toBeGreaterThan(0)
  })
})
