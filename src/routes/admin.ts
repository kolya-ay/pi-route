// src/routes/admin.ts

import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'

import { getAccount, listAccounts, setAccountInvalid } from '../admin/accounts'
import { AdminError } from '../admin/errors'
import type { RouterState } from '../state'

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  account_not_found: 404,
  method_not_allowed: 405
}

const InvalidBodySchema = z.object({ isInvalid: z.boolean() })

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

  admin.get('/accounts/:name', (c) => {
    const acc = getAccount(state, c.req.param('name'))
    if (!acc) {
      return c.json({ error: 'account_not_found', detail: { name: c.req.param('name') } }, 404)
    }
    return c.json(acc)
  })

  admin.patch('/accounts/:name/invalid', async (c) => {
    const body = InvalidBodySchema.parse(await c.req.json())
    await setAccountInvalid(state, c.req.param('name'), body.isInvalid)
    return c.body(null, 204)
  })

  // OAuth login moved to CLI (Task 13). Reject legacy login endpoint clearly.
  admin.all('/accounts/:name/login', (c) =>
    c.json(
      {
        error: 'method_not_allowed',
        detail: { message: 'OAuth login moved to CLI; use `pi-route login <provider>`' }
      },
      405
    )
  )

  app.route('/admin', admin)
}
