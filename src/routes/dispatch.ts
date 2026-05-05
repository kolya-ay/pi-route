// src/routes/dispatch.ts

import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'

import type { BackendEntry } from '../backends/registry'
import type { RouterOptions, RoutingStrategy, TelemetryEmitter } from '../types'

export type DispatchDeps = {
  format: 'anthropic' | 'openai'
  registry: Map<string, BackendEntry>
  routing: RoutingStrategy
  options: RouterOptions
  telemetry: TelemetryEmitter
}

export const createDispatchHandler = (deps: DispatchDeps) => async (c: Context) => {
  const requestId = c.get('requestId') as string
  const bodyText = await c.req.raw.text()
  const parsed = JSON.parse(bodyText) as Record<string, unknown>
  const model = String(parsed['model'] ?? '')
  const stream = Boolean(parsed['stream'])

  deps.telemetry.emit({
    type: 'request_start',
    requestId,
    timestamp: Date.now(),
    format: deps.format,
    model,
    stream
  })

  const decision = deps.routing.resolve({
    model,
    format: deps.format,
    headers: c.req.raw.headers,
    body: parsed,
    options: deps.options
  })

  if (!decision) {
    return c.json({ error: 'No routing decision' }, 502)
  }

  const entry = deps.registry.get(decision.backend)
  if (!entry) {
    return c.json({ error: `Backend "${decision.backend}" not found` }, 502)
  }

  const accountState = entry.pool.select(decision.model ?? model)
  if (!accountState) {
    return c.json({ error: 'No available accounts — all rate-limited or invalid' }, 429)
  }

  const finalModel = decision.model ?? model
  const finalBody =
    decision.model && decision.model !== model
      ? JSON.stringify({ ...parsed, model: decision.model })
      : bodyText

  const upstreamUrl = deps.options.backends[decision.backend]?.baseUrl ?? ''
  const rawReq = c.req.raw
  const outgoingRequest = new Request(upstreamUrl, {
    method: rawReq.method,
    headers: rawReq.headers,
    body: finalBody,
    duplex: 'half'
  } as RequestInit)

  try {
    const response = await entry.backend.dispatch(
      {
        id: requestId,
        format: deps.format,
        rawRequest: outgoingRequest,
        model: finalModel,
        stream
      },
      accountState.account
    )

    deps.telemetry.emit({
      type: 'request_end',
      requestId,
      timestamp: Date.now(),
      status: response.status,
      backend: decision.backend,
      model: finalModel,
      account: response.metadata.account,
      tokens: response.metadata.tokens,
      cost: response.metadata.cost,
      latencyMs: response.metadata.latencyMs
    })

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      const retryMs = retryAfter ? Number(retryAfter) * 1000 : 60_000
      entry.pool.markRateLimited(accountState, finalModel, retryMs)
      deps.telemetry.emit({
        type: 'ratelimit_hit',
        backend: decision.backend,
        account: accountState.account.name,
        model: finalModel,
        retryAfterMs: retryMs
      })
    }

    if (response.body instanceof ReadableStream) {
      return honoStream(c, async (s) => {
        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')
        await s.pipe(response.body as ReadableStream)
      })
    }

    return c.json(response.body as Record<string, unknown>, response.status as 200)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown backend error'
    entry.pool.markError(accountState, { message })
    deps.telemetry.emit({
      type: 'backend_error',
      requestId,
      backend: decision.backend,
      account: accountState.account.name,
      message
    })
    return c.json({ error: message }, 502)
  }
}
