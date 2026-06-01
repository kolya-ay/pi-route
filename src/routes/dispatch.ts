// src/routes/dispatch.ts

import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'

import { resolveKey } from '../auth/resolve'
import type { ProviderEntry } from '../providers/registry'
import type { RouterState } from '../state'
import type { RoutingStrategy, TelemetryEmitter } from '../types'

export type DispatchDeps = {
  format: 'anthropic' | 'openai'
  registry: Map<string, ProviderEntry>
  routing: RoutingStrategy
  state: RouterState
  telemetry: TelemetryEmitter
}

export const createDispatchHandler = (deps: DispatchDeps) => async (c: Context) => {
  const requestId = c.get('requestId') as string
  const bodyText = await c.req.raw.text()
  const parsed = JSON.parse(bodyText) as Record<string, unknown>
  const model = String(parsed.model ?? '')
  const stream = Boolean(parsed.stream)

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
    options: deps.state.options
  })

  if (!decision) {
    return c.json({ error: 'No routing decision' }, 502)
  }

  const entry = deps.registry.get(decision.provider)
  if (!entry) {
    return c.json({ error: `Provider "${decision.provider}" not found` }, 502)
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

  const upstreamUrl = deps.state.options.providers[decision.provider]?.baseUrl ?? ''
  const rawReq = c.req.raw
  const outgoingRequest = new Request(upstreamUrl, {
    method: rawReq.method,
    headers: rawReq.headers,
    body: finalBody,
    duplex: 'half'
  } as RequestInit)

  try {
    const apiKey = await resolveKey(deps.state, accountState.account)
    const response = await entry.provider.dispatch(
      {
        id: requestId,
        format: deps.format,
        rawRequest: outgoingRequest,
        model: finalModel,
        stream
      },
      accountState.account,
      apiKey
    )

    deps.telemetry.emit({
      type: 'request_end',
      requestId,
      timestamp: Date.now(),
      status: response.status,
      provider: decision.provider,
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
        provider: decision.provider,
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
    const message = err instanceof Error ? err.message : 'Unknown provider error'
    entry.pool.markError(accountState, { message })
    deps.telemetry.emit({
      type: 'provider_error',
      requestId,
      provider: decision.provider,
      account: accountState.account.name,
      message
    })
    return c.json({ error: message }, 502)
  }
}
