import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterState } from '../state'
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
  account: Account
): void => {
  if (account.type !== 'antigravity-oauth' && account.type !== 'openai-codex-oauth') return
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
      const fresh = readCredentialsSync(state.options.authDir, account.name)
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
  const timer = setTimeout(() => {
    void fire(state, providerName, account)
  }, delay)
  state.timers.set(account.name, timer)
}

const fire = async (state: RouterState, providerName: string, account: Account): Promise<void> => {
  try {
    await refreshAndStore(state, account)
    state.refreshFailures.delete(account.name)
    scheduleRefresh(state, providerName, account)
  } catch {
    const failures = (state.refreshFailures.get(account.name) ?? 0) + 1
    state.refreshFailures.set(account.name, failures)
    if (failures >= MAX_FAILURES) {
      state.telemetry.emit({
        type: 'account.refresh-given-up',
        account: account.name,
        attempts: failures
      })
      state.timers.delete(account.name)
      return
    }
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1))
    const timer = setTimeout(() => void fire(state, providerName, account), backoff)
    state.timers.set(account.name, timer)
  }
}

// scheduleRefresh is sync so it can be called from boot and CRUD paths without `await`.
const readCredentialsSync = (authDir: string, accountName: string): CredentialFile => {
  const path = join(authDir, `${accountName}.json`)
  return JSON.parse(readFileSync(path, 'utf-8')) as CredentialFile
}
