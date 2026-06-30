// src/routes/dispatch.ts

import { trace } from '@opentelemetry/api'
import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { endTime, startTime } from 'hono/timing'

import { resolveKey } from '../auth/resolve'
import { readEnvConfig } from '../config/env'
import { resolveCandidates } from '../pipeline/resolve'
import type { ProviderEntry } from '../providers/registry'
import { buildRequestCaptureAttrs, type CaptureOpts } from '../telemetry/capture'
import type { Env } from '../telemetry/hono-env'
import { extractSessionId } from '../telemetry/session-id'

// Headers that must not flow from an incoming client request to the outgoing
// upstream-provider request:
//   - host / content-length: fetch() recomputes both from the new URL and
//     body. Forwarding the original Host is the bug that surfaced as TLS
//     errors on Bun (SNI taken from Host instead of URL).
//   - hop-by-hop set (RFC 7230 §6.1): scoped to a single transport hop.
//   - cookie / origin / referer: browser-scoped client context that providers
//     don't need and shouldn't see.
const STRIPPED_HEADERS = [
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'origin',
  'referer'
]

const buildUpstreamHeaders = (incoming: Headers): Headers => {
  const h = new Headers(incoming)
  for (const name of STRIPPED_HEADERS) h.delete(name)
  return h
}

export type DispatchDeps = {
  format: 'anthropic' | 'openai' | 'responses'
  registry: Map<string, ProviderEntry>
}

// Read once at handler-build time — env is constant after boot, no need to
// re-read per request. Tests that need to toggle PI_ROUTE_CAPTURE_PROMPTS at
// runtime mount the handler after the env mutation.
const readCaptureOpts = (): CaptureOpts => {
  const env = readEnvConfig()
  return { capturePrompts: env.capturePrompts, maxBytes: env.captureMaxBytes }
}

export const createDispatchHandler = (deps: DispatchDeps) => {
  const captureOpts = readCaptureOpts()
  return async (c: Context<Env>) => {
    const requestId = c.var.requestId
    const tel = c.var.tel
    const state = c.var.state

    const bodyText = await c.req.raw.text()
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const model = String(parsed.model ?? '')
    const stream = Boolean(parsed.stream)
    const sessionId = extractSessionId(c.req.raw.headers, parsed)
    // Built once per request; spread into every dispatch_attempt span so retries
    // and failover hops all carry the captured prompt/system/tools.
    const requestCaptureAttrs = buildRequestCaptureAttrs(captureOpts, parsed)

    const rootSpan = trace.getActiveSpan()
    rootSpan?.setAttributes({
      'pi.request_id': requestId,
      'gen_ai.request.model': model,
      'gen_ai.request.stream': stream,
      'gen_ai.conversation.id': sessionId
    })

    const thinking = (parsed.thinking as { type?: string } | undefined)?.type === 'enabled'

    let candidates: { provider: string; modelId: string }[]
    try {
      candidates = resolveCandidates(state.options, state.catalog, model, { thinking })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No routing decision'
      return c.json({ error: message }, 502)
    }
    if (candidates.length === 0) return c.json({ error: 'No routing decision' }, 502)

    let lastErr: unknown = null
    let lastProvider = candidates[0]!.provider

    // Pre-failover, gate paths (registry-miss / account.disabled / runtime.isInvalid)
    // returned 500/503 directly. The loop-uniform 502 is the intentional cost of
    // `strategy: failover`'s "any failure advances" rule.
    startTime(c, 'upstream')
    for (let i = 0; i < candidates.length; i += 1) {
      const decision = candidates[i]!
      lastProvider = decision.provider

      const emitFallback = (reason: string): void => {
        if (i + 1 < candidates.length && rootSpan) {
          rootSpan.addEvent('provider_fallback', {
            'pi.from': `${decision.provider}/${decision.modelId}`,
            'pi.to': `${candidates[i + 1]!.provider}/${candidates[i + 1]!.modelId}`,
            'pi.reason': reason
          })
        }
      }

      const entry = deps.registry.get(decision.provider)
      const runtime = state.runtime.accounts[decision.provider]
      const gateError = !entry
        ? `provider "${decision.provider}" not in registry`
        : entry.account.disabled === true
          ? `provider "${decision.provider}" account is disabled`
          : runtime?.isInvalid === true
            ? `provider "${decision.provider}" account marked invalid`
            : null
      if (gateError !== null) {
        lastErr = new Error(gateError)
        emitFallback(gateError)
        continue
      }
      const safeEntry = entry!

      const finalModel = decision.modelId
      const finalBody =
        finalModel !== model ? JSON.stringify({ ...parsed, model: finalModel }) : bodyText
      const rawReq = c.req.raw
      const outgoingRequest = new Request(rawReq.url, {
        method: rawReq.method,
        headers: buildUpstreamHeaders(rawReq.headers),
        body: finalBody,
        duplex: 'half'
      } as RequestInit)

      const result = await tel.withSpan(
        'gen_ai.dispatch_attempt',
        {
          'gen_ai.provider.name': decision.provider,
          'gen_ai.request.model': finalModel,
          'gen_ai.operation.name': 'chat',
          'pi.attempt_index': i,
          ...requestCaptureAttrs
        },
        async (span): Promise<Response | null> => {
          try {
            const apiKey = await resolveKey(state, safeEntry.account, tel)
            const response = await safeEntry.provider.dispatch(
              {
                id: requestId,
                format: deps.format,
                rawRequest: outgoingRequest,
                model: finalModel,
                stream,
                telHooks: { tel, span, capture: captureOpts }
              },
              safeEntry.account,
              apiKey
            )

            if (response.metadata.account)
              span.setAttribute('pi.account', response.metadata.account)
            if (response.metadata.cost)
              span.setAttribute('gen_ai.usage.cost_usd', response.metadata.cost.total)
            if (response.metadata.tokens) {
              span.setAttribute('gen_ai.usage.input_tokens', response.metadata.tokens.input)
              span.setAttribute('gen_ai.usage.output_tokens', response.metadata.tokens.output)
            }

            if (response.body instanceof ReadableStream) {
              // Tee the source so we can both pipe to the client AND know when the
              // upstream stream is fully consumed. Keeping the attempt span open
              // until the source ends is essential — wrapStreamForMetrics records
              // TTFT/cost/tokens DURING pull(), and those setAttribute calls are
              // silently no-ops once the span has ended. tee() throttles source
              // reads to the slower branch (the client pipe), so the completion
              // branch never buffers ahead and there's no memory leak.
              const [forClient, forCompletion] = (response.body as ReadableStream).tee()
              const completion = (async (): Promise<void> => {
                const reader = forCompletion.getReader()
                try {
                  while (true) {
                    const { done } = await reader.read()
                    if (done) return
                  }
                } catch {
                  // Errors surface via the client pipe; we just need to know the
                  // stream finished one way or another.
                } finally {
                  reader.releaseLock()
                }
              })()
              const httpResponse = honoStream(c, async (s) => {
                s.onAbort(() => {
                  rootSpan?.addEvent('stream_aborted', {})
                })
                c.header('Content-Type', 'text/event-stream')
                c.header('Cache-Control', 'no-cache')
                c.header('Connection', 'keep-alive')
                await s.pipe(forClient)
              })
              await completion
              return httpResponse
            }
            return c.json(response.body as Record<string, unknown>, response.status as 200)
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message.slice(0, 200) : String(err)
            span.addEvent('provider_error', { 'error.message': message })
            lastErr = err
            emitFallback(message)
            return null
          }
        }
      )

      if (result !== null) {
        endTime(c, 'upstream')
        return result
      }
    }
    endTime(c, 'upstream')

    const message = lastErr instanceof Error ? lastErr.message : 'Unknown provider error'
    rootSpan?.addEvent('provider_error_final', {
      'pi.provider': lastProvider,
      'error.message': message
    })
    return c.json({ error: message }, 502)
  }
}
