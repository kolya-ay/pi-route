// src/routes/dispatch.ts

import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { endTime, startTime } from 'hono/timing'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { readEnvConfig } from '../config/env'
import { resolveCandidates } from '../pipeline/resolve'
import {
  DispatchAuthError,
  ModelNotOfferedError,
  UpstreamError
} from '../providers/models-dispatch'
import {
  parseStructuredOutput,
  type StructuredOutput,
  StructuredOutputRequestError
} from '../structured-output'
import { buildRequestCaptureAttrs, type CaptureOpts } from '../telemetry/capture'
import type { Env } from '../telemetry/hono-env'
import { extractSessionId } from '../telemetry/session-id'
import type { ProviderEntry } from '../types'

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

// Ends the attempt span once the client has the whole body or walks away: stream
// metrics land on the span while the body is read, so it must outlive the handler.
// Pull-driven, so the upstream is read no faster than the client consumes it.
// A read pending at cancel still settles afterwards; only the first settle counts.
export const endOnSettle = (
  body: ReadableStream<Uint8Array>,
  span: Span
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let settled = false
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    span.end()
    return true
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (!done) return controller.enqueue(value)
        if (settle()) controller.close()
      } catch (err) {
        if (settle()) controller.error(err)
      }
    },
    cancel(reason) {
      span.addEvent('stream_aborted')
      settle()
      return reader.cancel(reason)
    }
  })
}

type Failure = { address: string; status?: number; message: string }

// Statuses a client can act on (fix the request, pay, back off, pick another model,
// retry later). Upstream 401/403 describe pi-route's key, not the client's, so they
// become 502.
const FORWARDED_STATUSES = new Set([400, 402, 404, 413, 422, 429, 503])

const statusOf = (err: unknown): number | undefined =>
  err instanceof UpstreamError ? err.status : err instanceof ModelNotOfferedError ? 404 : undefined

// Forward the upstream status only when every candidate agrees on it.
const finalStatus = (failures: Failure[]): number => {
  const status = failures[0]?.status
  return status !== undefined &&
    FORWARDED_STATUSES.has(status) &&
    failures.every((f) => f.status === status)
    ? status
    : 502
}

const describeFailure = (f: Failure): string => `${f.address} ${f.status ?? '-'} (${f.message})`

const attemptsHeader = (failures: Failure[], servedBy?: string): string =>
  [
    ...failures.map((f) => `${f.address} ${f.status ?? '-'}`),
    ...(servedBy ? [`${servedBy} ok`] : [])
  ].join('; ')

const errorType = (status: number): string =>
  status === 400 || status === 413 || status === 422
    ? 'invalid_request_error'
    : status === 401
      ? 'authentication_error'
      : 'api_error'

// Each wire format's own error envelope, so clients show the message rather than
// a bare status.
const errorBody = (
  format: DispatchDeps['format'],
  status: number,
  message: string,
  attempts?: Failure[]
): Record<string, unknown> => {
  const error = { type: errorType(status), message, ...(attempts ? { attempts } : {}) }
  return format === 'anthropic' ? { type: 'error', error } : { error: { ...error, code: null } }
}

export const createDispatchHandler = (deps: DispatchDeps) => {
  const captureOpts = readCaptureOpts()
  return async (c: Context<Env>) => {
    const requestId = c.var.requestId
    const tel = c.var.tel
    const state = c.var.state
    const fail = (status: number, message: string, attempts?: Failure[]) =>
      c.json(errorBody(deps.format, status, message, attempts), status as ContentfulStatusCode)

    const bodyText = await c.req.raw.text()
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const model = String(parsed.model ?? '')
    const stream = Boolean(parsed.stream)
    const sessionId = extractSessionId(c.req.raw.headers, parsed)

    // Parsed once, before routing: an unenforceable or malformed schema is a client
    // error, so it must not be retried across failover candidates as a 502.
    let structuredOutput: StructuredOutput | undefined
    try {
      structuredOutput = parseStructuredOutput(deps.format, parsed)
    } catch (err) {
      if (err instanceof StructuredOutputRequestError) return fail(400, err.message)
      throw err
    }
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
      return fail(502, message)
    }
    if (candidates.length === 0) return fail(502, 'No routing decision')

    const failures: Failure[] = []
    // Every exit after routing names the attempts made so far.
    const giveUp = (status: number, message: string, attempts?: Failure[]) => {
      endTime(c, 'upstream')
      c.header('x-pi-route-attempts', attemptsHeader(failures))
      return fail(status, message, attempts)
    }
    const aborted = () => giveUp(502, `${model}: client aborted`)

    // Gate failures (registry miss, disabled, logged out, invalid) carry no status,
    // so any mix with them resolves to 502 under the agree-or-502 rule.
    startTime(c, 'upstream')
    const rawReq = c.req.raw
    for (let i = 0; i < candidates.length; i += 1) {
      const decision = candidates[i]
      if (!decision) continue
      if (rawReq.signal.aborted) return aborted()
      const address = `${decision.provider}/${decision.modelId}`
      const next = candidates[i + 1]
      const recordFailure = (status: number | undefined, message: string): Failure => {
        const failure = {
          address,
          ...(status !== undefined ? { status } : {}),
          message: message.slice(0, 200)
        }
        failures.push(failure)
        return failure
      }
      const hop = (failure: Failure): void => {
        if (!next) return
        const to = `${next.provider}/${next.modelId}`
        rootSpan?.addEvent('provider_fallback', {
          'pi.from': address,
          'pi.to': to,
          'pi.reason': failure.message
        })
        console.warn(`[failover] ${model}: ${describeFailure(failure)} → ${to}`)
      }

      const entry = deps.registry.get(decision.provider)
      const runtime = state.runtime.accounts[decision.provider]
      const gateError = !entry
        ? `provider "${decision.provider}" not in registry`
        : entry.account.disabled === true
          ? `provider "${decision.provider}" account is disabled`
          : !state.catalog.available.has(decision.provider)
            ? `provider "${decision.provider}" is not logged in (run: pi-route provider login ${decision.provider})`
            : runtime?.isInvalid === true
              ? `provider "${decision.provider}" account marked invalid`
              : null
      if (gateError !== null) {
        hop(recordFailure(undefined, gateError))
        continue
      }
      if (!entry) continue

      const finalModel = decision.modelId
      const finalBody =
        finalModel !== model ? JSON.stringify({ ...parsed, model: finalModel }) : bodyText
      const outgoingRequest = new Request(rawReq.url, {
        method: rawReq.method,
        headers: buildUpstreamHeaders(rawReq.headers),
        body: finalBody,
        signal: rawReq.signal,
        duplex: 'half'
      } as RequestInit)

      const span = tel.startSpan('gen_ai.dispatch_attempt', {
        'gen_ai.provider.name': decision.provider,
        'gen_ai.request.model': finalModel,
        'gen_ai.operation.name': 'chat',
        'pi.attempt_index': i,
        ...requestCaptureAttrs
      })
      try {
        // Models-backed providers resolve auth inside models.stream() and ignore
        // this arg; passthrough/openai providers need their configured key.
        const apiKey = entry.account.credential === 'key' ? entry.account.key : ''
        // Active for the call so providers' getActiveSpan() finds the attempt.
        const response = await context.with(trace.setSpan(context.active(), span), () =>
          entry.provider.dispatch(
            {
              id: requestId,
              format: deps.format,
              rawRequest: outgoingRequest,
              model: finalModel,
              stream,
              ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              telHooks: { tel, span, capture: captureOpts }
            },
            entry.account,
            apiKey
          )
        )

        if (response.metadata.account) span.setAttribute('pi.account', response.metadata.account)
        if (response.metadata.cost)
          span.setAttribute('gen_ai.usage.cost_usd', response.metadata.cost.total)
        if (response.metadata.tokens) {
          span.setAttribute('gen_ai.usage.input_tokens', response.metadata.tokens.input)
          span.setAttribute('gen_ai.usage.output_tokens', response.metadata.tokens.output)
        }
        endTime(c, 'upstream')
        c.header('x-pi-route-served-by', address)
        c.header('x-pi-route-attempts', attemptsHeader(failures, address))

        if (response.body instanceof ReadableStream) {
          const body = endOnSettle(response.body as ReadableStream<Uint8Array>, span)
          c.header('Content-Type', 'text/event-stream')
          c.header('Cache-Control', 'no-cache')
          c.header('Connection', 'keep-alive')
          return honoStream(c, (s) => s.pipe(body))
        }
        span.end()
        return c.json(response.body as Record<string, unknown>, response.status as 200)
      } catch (err: unknown) {
        // The client left: nothing failed, and nobody is waiting for another member.
        if (rawReq.signal.aborted) {
          span.end()
          return aborted()
        }
        const message = err instanceof Error ? err.message : String(err)
        span.addEvent('provider_error', { 'error.message': message })
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.end()
        // An OAuth failure won't be fixed by the next candidate (401), nor will a
        // schema this backend cannot express (400, the client's to fix) — short-circuit
        // instead of failing over and masking it as a 502.
        const shortCircuit =
          err instanceof DispatchAuthError
            ? 401
            : err instanceof StructuredOutputRequestError
              ? 400
              : undefined
        const failure = recordFailure(shortCircuit ?? statusOf(err), message)
        if (shortCircuit !== undefined) return giveUp(shortCircuit, message)
        hop(failure)
      }
    }

    const status = finalStatus(failures)
    const message = `${model}: ${failures.map(describeFailure).join('; ')}`
    rootSpan?.addEvent('provider_error_final', {
      'pi.provider': failures.at(-1)?.address ?? '',
      'error.message': message
    })
    console.warn(`[failover] ${model}: all ${failures.length} members failed → ${status}`)
    return giveUp(status, message, failures)
  }
}
