import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'

import { _setTestExporter, createTel, initOtel, shutdownOtel } from './tel'
import { useTestExporter } from './test-fixture'

describe('initOtel', () => {
  it('a later registration wins over an earlier one', async () => {
    const first = new InMemorySpanExporter()
    _setTestExporter(first)
    const second = new InMemorySpanExporter()
    _setTestExporter(second)

    await createTel().withSpan('probe', {}, async () => undefined)

    expect(second.getFinishedSpans().map((s) => s.name)).toContain('probe')
    expect(first.getFinishedSpans()).toHaveLength(0)
    await shutdownOtel()
  })

  it('initOtel after a test exporter does not leave the old provider registered', async () => {
    const exporter = new InMemorySpanExporter()
    _setTestExporter(exporter)
    initOtel({ otlpUrl: '', serviceName: 'pi-route-test' })
    _setTestExporter(exporter)
    exporter.reset()

    await createTel().withSpan('after-init', {}, async () => undefined)

    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('after-init')
    await shutdownOtel()
  })

  it('a production shutdown clears the global so a later test exporter registers', async () => {
    // Production path: real NodeSDK, registers a global provider. A bogus URL is
    // fine — BatchSpanProcessor never connects unless flushed.
    initOtel({ otlpUrl: 'http://localhost:9', serviceName: 't' })
    await shutdownOtel()

    const exporter = new InMemorySpanExporter()
    _setTestExporter(exporter)
    await createTel().withSpan('after-prod-shutdown', {}, async () => undefined)
    await shutdownOtel()

    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('after-prod-shutdown')
  })
})

describe('Tel facade — disabled (no exporters)', () => {
  beforeEach(() => initOtel({ otlpUrl: '', serviceName: 't' }))
  afterEach(() => shutdownOtel())

  it('withSpan still runs fn and returns its value', async () => {
    const tel = createTel()
    const out = await tel.withSpan('x', {}, async () => 42)
    expect(out).toBe(42)
  })

  it('event is a no-op (does not throw)', () => {
    const tel = createTel()
    tel.event('anything', { a: 1 })
  })
})

describe('Tel facade — InMemory exporter for assertions', () => {
  const exporter = useTestExporter()

  it('withSpan creates a span with the given name and attrs', async () => {
    const tel = createTel()
    await tel.withSpan(
      'gen_ai.dispatch_attempt',
      { 'gen_ai.provider.name': 'anthropic' },
      async (span) => {
        expect(span.isRecording()).toBe(true)
      }
    )
    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBe(1)
    expect(spans[0]?.name).toBe('gen_ai.dispatch_attempt')
    expect(spans[0]?.attributes['gen_ai.provider.name']).toBe('anthropic')
  })

  it('event adds a span event to the active span', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async () => {
      tel.event('provider_fallback', { 'pi.from': 'a', 'pi.to': 'b' })
    })
    const spans = exporter.getFinishedSpans()
    expect(spans[0]?.events.length).toBe(1)
    expect(spans[0]?.events[0]?.name).toBe('provider_fallback')
    expect(spans[0]?.events[0]?.attributes?.['pi.from']).toBe('a')
  })

  it('withSpan sets ERROR status when fn throws', async () => {
    const tel = createTel()
    await expect(
      tel.withSpan('outer', {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const spans = exporter.getFinishedSpans()
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR)
  })

  it('recordTTFT sets pi.time_to_first_token_ms attribute', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      tel.recordTTFT(span, 123)
    })
    expect(exporter.getFinishedSpans()[0]?.attributes['pi.time_to_first_token_ms']).toBe(123)
  })

  it('recordCompletion sets usage, cost, and tokens-per-sec attributes', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      tel.recordCompletion(span, { input: 100, output: 50 }, 0.0042, 25)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    expect(attrs?.['gen_ai.usage.input_tokens']).toBe(100)
    expect(attrs?.['gen_ai.usage.output_tokens']).toBe(50)
    expect(attrs?.['gen_ai.usage.cost_usd']).toBe(0.0042)
    expect(attrs?.['pi.output_tokens_per_second']).toBe(25)
  })

  it('recordCompletion captures cacheRead=0 (not dropped) and cacheWrite when set', async () => {
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      tel.recordCompletion(span, { input: 1, output: 1, cacheRead: 0, cacheWrite: 10 }, 0, 0)
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    expect(attrs?.['pi.usage.cache_read_tokens']).toBe(0)
    expect(attrs?.['pi.usage.cache_write_tokens']).toBe(10)
  })
})
