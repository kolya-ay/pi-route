// src/routes/admin.ts

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'

import {
  addAccount,
  disableAccount,
  listAccounts,
  loginAccount,
  removeAccount
} from '../admin/accounts'
import { AdminError } from '../admin/errors'
import type { RouterState } from '../state'

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  provider_not_found: 404,
  account_not_found: 404,
  account_conflict: 409,
  login_timeout: 408
}

const PatchBodySchema = z.object({ disabled: z.boolean() })

export const mountAdmin = (
  app: Hono<{ Variables: { requestId: string } }>,
  state: RouterState,
  opts: { authKey: string }
): void => {
  const admin = new Hono()

  admin.use('*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${opts.authKey}`) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
    return
  })

  admin.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: 'invalid_request', issues: err.issues }, 400)
    }
    if (err instanceof AdminError) {
      const status = STATUS_BY_CODE[err.code] ?? 500
      return c.json({ error: err.code, detail: err.detail }, status)
    }
    return c.json({ error: 'internal_error', message: err.message }, 500)
  })

  admin.get('/accounts', (c) => c.json(listAccounts(state)))

  admin.post('/accounts/:provider', async (c) => {
    const body = (await c.req.json()) as Parameters<typeof addAccount>[2]
    await addAccount(state, c.req.param('provider'), body)
    return c.json(body, 201)
  })

  admin.delete('/accounts/:provider/:name', async (c) => {
    await removeAccount(state, c.req.param('provider'), c.req.param('name'))
    return c.body(null, 204)
  })

  admin.patch('/accounts/:provider/:name', async (c) => {
    const body = PatchBodySchema.parse(await c.req.json())
    await disableAccount(state, c.req.param('provider'), c.req.param('name'), body.disabled)
    return c.body(null, 204)
  })

  admin.post('/accounts/:provider/:name/login', (c) =>
    streamSSE(c, async (stream) => {
      const provider = c.req.param('provider')
      const name = c.req.param('name')
      try {
        await loginAccount(
          state,
          provider,
          name,
          {
            onAuth: ({ url }) => stream.writeSSE({ event: 'auth', data: JSON.stringify({ url }) }),
            // OAuthLoginCallbacks requires onPrompt; antigravity-oauth never calls it.
            onPrompt: async () => '',
            onProgress: (msg) => stream.writeSSE({ event: 'progress', data: msg })
          },
          { signal: c.req.raw.signal }
        )
        await stream.writeSSE({ event: 'done', data: '' })
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        })
      }
    })
  )

  app.route('/admin', admin)
}
