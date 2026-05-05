// src/telemetry/emitter.ts

import type { TelemetryEmitter, TelemetryEvent, TelemetrySink } from '../types'

export const createTelemetryEmitter = (sinks: TelemetrySink[]): TelemetryEmitter => ({
  sinks,
  emit(event: TelemetryEvent): void {
    sinks.forEach((sink) => {
      try {
        sink.emit(event)
      } catch {
        // swallow sink errors
      }
    })
  }
})

export const createConsoleSink = (): TelemetrySink => ({
  emit(event: TelemetryEvent): void {
    process.stdout.write(JSON.stringify(event) + '\n')
  }
})
