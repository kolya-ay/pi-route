// src/telemetry/emitter.test.ts

import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent, TelemetrySink } from '../types.js'
import { createConsoleSink, createTelemetryEmitter } from './emitter.js'

const event: TelemetryEvent = {
  type: 'request_start',
  requestId: 'req-1',
  timestamp: 1000,
  format: 'anthropic',
  model: 'claude-3',
  stream: false,
}

describe('createTelemetryEmitter', () => {
  it('fans out events to all sinks', () => {
    const sink1: TelemetrySink = { emit: vi.fn() }
    const sink2: TelemetrySink = { emit: vi.fn() }
    const emitter = createTelemetryEmitter([sink1, sink2])
    emitter.emit(event)
    expect(sink1.emit).toHaveBeenCalledWith(event)
    expect(sink2.emit).toHaveBeenCalledWith(event)
  })

  it('works with zero sinks', () => {
    const emitter = createTelemetryEmitter([])
    expect(() => emitter.emit(event)).not.toThrow()
  })

  it('does not throw if a sink throws', () => {
    const badSink: TelemetrySink = {
      emit: () => {
        throw new Error('sink failure')
      },
    }
    const goodSink: TelemetrySink = { emit: vi.fn() }
    const emitter = createTelemetryEmitter([badSink, goodSink])
    expect(() => emitter.emit(event)).not.toThrow()
    expect(goodSink.emit).toHaveBeenCalledWith(event)
  })
})

describe('createConsoleSink', () => {
  it('writes JSON to stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const sink = createConsoleSink()
    sink.emit(event)
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(event) + '\n')
    writeSpy.mockRestore()
  })
})
