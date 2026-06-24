// src/routes/dispatch.ts

import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'

import { resolveKey } from '../auth/resolve'
import { resolveModel } from '../pipeline/resolve'
import { type ProviderEntry, resolveBaseUrl } from '../providers/registry'
import type { RouterState } from '../state'
import type { TelemetryEmitter } from '../types'

export type DispatchDeps = {
  format: 'anthropic' | 'openai'
  registry: Map<string, ProviderEntry>
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

  const thinking = (parsed.thinking as { type?: string } | undefined)?.type === 'enabled'

  let decision: { provider: string; modelId: string }
  try {
    decision = resolveModel(deps.state.options, deps.state.catalog, model, { thinking })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No routing decision'
    return c.json({ error: message }, 502)
  }

  const entry = deps.registry.get(decision.provider)
  if (!entry) {
    return c.json({ error: `provider "${decision.provider}" not in registry` }, 500)
  }

  if (entry.account.disabled === true) {
    return c.json({ error: `provider "${decision.provider}" account is disabled` }, 503)
  }
  const runtime = deps.state.runtime.accounts[decision.provider]
  if (runtime?.isInvalid === true) {
    return c.json({ error: `provider "${decision.provider}" account marked invalid` }, 503)
  }

  const finalModel = decision.modelId
  const finalBody =
    finalModel !== model ? JSON.stringify({ ...parsed, model: finalModel }) : bodyText

  const providerConfig = deps.state.options.providers[decision.provider]
  const upstreamUrl = resolveBaseUrl(providerConfig?.type ?? '', providerConfig?.baseUrl)
  const rawReq = c.req.raw
  const outgoingRequest = new Request(upstreamUrl, {
    method: rawReq.method,
    headers: rawReq.headers,
    body: finalBody,
    duplex: 'half'
  } as RequestInit)

  try {
    const apiKey = await resolveKey(deps.state, entry.account, entry.provider.type)
    const response = await entry.provider.dispatch(
      {
        id: requestId,
        format: deps.format,
        rawRequest: outgoingRequest,
        model: finalModel,
        stream
      },
      entry.account,
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
    deps.telemetry.emit({
      type: 'provider_error',
      requestId,
      provider: decision.provider,
      message
    })
    return c.json({ error: message }, 502)
  }
}
