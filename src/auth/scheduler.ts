import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SpanStatusCode } from '@opentelemetry/api'

import type { RouterState } from '../state'
import type { Tel } from '../telemetry/tel'
import type { Account } from '../types'
import type { CredentialFile } from './credentials'
import { refreshAndStore } from './credentials'

const REFRESH_LEAD_MS = 60_000
const MIN_DELAY_MS = 1000
const MAX_BACKOFF_MS = 60_000
const MAX_FAILURES = 6
const MAX_SETTIMEOUT_MS = 2 ** 31 - 1

export const cancelRefresh = (state: RouterState, accountName: string): void => {
  const timer = state.timers.get(accountName)
  if (timer !== undefined) clearTimeout(timer)
  state.timers.delete(accountName)
  state.refreshFailures.delete(accountName)
}

export const scheduleRefresh = (
  state: RouterState,
  providerName: string,
  account: Account,
  tel: Tel
): void => {
  if (account.credential !== 'oauth') return
  if (account.disabled === true) return

  const existing = state.timers.get(account.name)
  if (existing !== undefined) {
    clearTimeout(existing)
    state.timers.delete(account.name)
  }

  let expires: number
  const cached = state.credentials.get(account.name)
  if (cached !== undefined) {
    expires = cached.expires
  } else {
    try {
      const fresh = readCredentialsSync(state.authDir, account.name)
      state.credentials.set(account.name, fresh)
      expires = fresh.expires
    } catch {
      // Credential file missing — loginAccount will re-schedule once written.
      return
    }
  }

  const delay = Math.min(
    MAX_SETTIMEOUT_MS,
    Math.max(MIN_DELAY_MS, expires - Date.now() - REFRESH_LEAD_MS)
  )
  const oauthAccount = account
  const timer = setTimeout(() => {
    void fire(state, providerName, oauthAccount, tel)
  }, delay)
  state.timers.set(account.name, timer)
}

const fire = async (
  state: RouterState,
  providerName: string,
  account: Account & { credential: 'oauth' },
  tel: Tel
): Promise<void> => {
  const givenUp = await tel.withSpan(
    'account.refresh',
    { 'pi.account': account.name },
    async (span): Promise<number | null> => {
      try {
        await refreshAndStore(state, account, tel)
        state.refreshFailures.delete(account.name)
        const cached = state.credentials.get(account.name)
        if (cached) span.setAttribute('pi.expires', cached.expires)
        scheduleRefresh(state, providerName, account, tel)
        return null
      } catch (err) {
        // withSpan only flips status to ERROR on throw; we catch and return,
        // so set status explicitly so SigNoz "errors only" views surface this.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err)
        })
        const failures = (state.refreshFailures.get(account.name) ?? 0) + 1
        state.refreshFailures.set(account.name, failures)
        span.addEvent('account.refresh.failed', {
          'pi.account': account.name,
          'error.message': err instanceof Error ? err.message : String(err)
        })
        if (failures >= MAX_FAILURES) {
          state.timers.delete(account.name)
          return failures
        }
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1))
        const timer = setTimeout(() => void fire(state, providerName, account, tel), backoff)
        state.timers.set(account.name, timer)
        return null
      }
    }
  )
  if (givenUp !== null) {
    await tel.withSpan(
      'account.refresh.given_up',
      { 'pi.account': account.name, 'pi.attempts': givenUp },
      async () => undefined
    )
  }
}

// scheduleRefresh is sync so it can be called from boot and CRUD paths without `await`.
const readCredentialsSync = (authDir: string, accountName: string): CredentialFile => {
  const path = join(authDir, `${accountName}.json`)
  return JSON.parse(readFileSync(path, 'utf-8')) as CredentialFile
}
