import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter
} from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const TRACER_NAME = 'pi-route'

// Production: NodeSDK manages resource detection + registration.
// Tests: NodeTracerProvider used directly to allow re-registration across test
// suites (NodeSDK's ProxyTracerProvider only accepts one delegate; the test
// provider path calls trace.disable() before re-registering so subsequent
// test files get a fresh span processor).
let sdk: NodeSDK | undefined
let testProvider: NodeTracerProvider | undefined
let enabled = false

export type Tel = {
  withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T>
  event(name: string, attrs: Attributes): void
  recordTTFT(span: Span, ms: number): void
  recordCompletion(
    span: Span,
    usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
    costUsd: number,
    tokensPerSec: number
  ): void
}

type InitOtelOpts = {
  otlpUrl: string
  serviceName: string
}

export const initOtel = (opts: InitOtelOpts): void => {
  if (sdk) {
    void sdk.shutdown()
    sdk = undefined
    enabled = false
  }
  if (!opts.otlpUrl) {
    enabled = false
    return
  }
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpUrl}/v1/traces` }))
    ]
  })
  sdk.start()
  enabled = true
}

export const shutdownOtel = async (): Promise<void> => {
  enabled = false
  if (testProvider) {
    // Don't call testProvider.shutdown() — that propagates to the exporter and
    // sets _stopped=true on InMemorySpanExporter, permanently silencing it for
    // subsequent tests that reuse the same instance. We only need the global
    // tracer provider reset so the next _setTestExporter call can re-register.
    testProvider = undefined
    trace.disable()
  }
  if (sdk) {
    await sdk.shutdown()
    sdk = undefined
  }
}

// Test hook — registers a NodeTracerProvider with a SimpleSpanProcessor so
// InMemorySpanExporter sees spans synchronously.
//
// Why NodeTracerProvider instead of NodeSDK:
//   NodeSDK wraps the real provider in a ProxyTracerProvider singleton that
//   accepts exactly one delegate. Starting a second NodeSDK instance doesn't
//   update that delegate, so spans from the second test run go nowhere.
//   NodeTracerProvider.register() + trace.disable() between runs sidesteps
//   the singleton lock.
//
// Why autoDetectResources is not set:
//   NodeTracerProvider doesn't run resource detectors by default, so
//   span.resource.asyncAttributesPending is false and SimpleSpanProcessor
//   exports synchronously — enabling inline assertions after withSpan returns.
export const _setTestExporter = (exporter: SpanExporter): void => {
  if (testProvider) {
    void testProvider.shutdown()
    testProvider = undefined
    trace.disable()
  }
  testProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'pi-route-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  })
  testProvider.register()
  enabled = true
}

export const createTel = (): Tel => {
  const tracer = trace.getTracer(TRACER_NAME)
  return {
    async withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
      if (!enabled) {
        return fn(tracer.startSpan('noop'))
      }
      return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
        try {
          // No setStatus(OK) on success: OTel treats UNSET as success in viewers
          // (SigNoz, Jaeger), and explicit OK is a one-way ratchet that would
          // mask inner code that sets ERROR before returning (e.g. account.refresh
          // catching its error and emitting a failed event without rethrowing).
          return await fn(span)
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err)
          })
          throw err
        } finally {
          span.end()
        }
      })
    },
    event(name: string, attrs: Attributes): void {
      if (!enabled) return
      const active = trace.getActiveSpan()
      if (active) active.addEvent(name, attrs)
    },
    recordTTFT(span: Span, ms: number): void {
      span.setAttribute('pi.time_to_first_token_ms', ms)
    },
    recordCompletion(span, usage, costUsd, tokensPerSec): void {
      span.setAttributes({
        'gen_ai.usage.input_tokens': usage.input,
        'gen_ai.usage.output_tokens': usage.output,
        'gen_ai.usage.cost_usd': costUsd,
        'pi.output_tokens_per_second': tokensPerSec,
        ...(usage.cacheRead !== undefined ? { 'pi.usage.cache_read_tokens': usage.cacheRead } : {}),
        ...(usage.cacheWrite !== undefined
          ? { 'pi.usage.cache_write_tokens': usage.cacheWrite }
          : {})
      })
    }
  }
}
