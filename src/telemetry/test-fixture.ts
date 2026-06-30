import { afterEach, beforeEach } from 'bun:test'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'

import { _setTestExporter, initOtel, shutdownOtel } from './tel'

// Sets up an InMemorySpanExporter for the surrounding describe(). Returns the
// exporter so tests can call .getFinishedSpans(). The OTel SDK is reset between
// each test, so spans from one don't leak into the next.
export const useTestExporter = (): InMemorySpanExporter => {
  const exporter = new InMemorySpanExporter()
  beforeEach(() => {
    initOtel({ otlpUrl: '', serviceName: 'pi-route-test' })
    _setTestExporter(exporter)
    exporter.reset()
  })
  afterEach(async () => {
    await shutdownOtel()
  })
  return exporter
}
