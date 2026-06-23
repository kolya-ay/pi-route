#!/usr/bin/env bun
// src/cli.ts

import { addAccount, loginAccount, persistLoginCredentials } from './admin/accounts'
import { loadRouter } from './app'

const verb = Bun.argv[2]
const providerName = Bun.argv[3]
const accountNameArg = Bun.argv[4]

if (verb !== 'login' || !providerName) {
  console.error('Usage: pi-route login <provider> [<account-name>]')
  process.exit(1)
}

const configPath = Bun.env.ROUTER_CONFIG ?? 'router.json'
const adminUrl = Bun.env.PI_ROUTE_ADMIN_URL
const adminKey = Bun.env.PI_ROUTE_ADMIN_KEY

const tryOpen = (url: string): void => {
  for (const opener of [
    ['xdg-open', url],
    ['open', url]
  ] as const) {
    try {
      Bun.spawn(opener as unknown as string[]).exited.catch(() => {})
      return
    } catch {
      // try next
    }
  }
}

const loginViaHttp = async (
  baseUrl: string,
  key: string,
  provider: string,
  name: string
): Promise<void> => {
  const res = await fetch(`${baseUrl}/admin/accounts/${provider}/${name}/login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!res.ok) {
    console.error(`HTTP login failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const reader = res.body?.getReader()
  if (!reader) {
    console.error('No response body from admin SSE endpoint')
    process.exit(1)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const evt of events) {
      let eventLine: string | undefined
      let dataLine: string | undefined
      for (const line of evt.split('\n')) {
        if (line.startsWith('event: ')) eventLine = line.slice(7)
        else if (line.startsWith('data: ')) dataLine = line.slice(6)
      }
      if (eventLine === 'auth' && dataLine) {
        const { url } = JSON.parse(dataLine) as { url: string }
        console.error(`Open in browser: ${url}`)
        tryOpen(url)
      } else if (eventLine === 'progress' && dataLine) {
        console.error(`… ${dataLine}`)
      } else if (eventLine === 'error' && dataLine) {
        console.error(`Login error: ${dataLine}`)
        process.exit(1)
      } else if (eventLine === 'done') {
        return
      }
    }
  }
}

const accountTypeFor = (providerType: string): 'antigravity-oauth' | 'openai-codex-oauth' => {
  if (providerType === 'antigravity') return 'antigravity-oauth'
  if (providerType === 'openai-codex') return 'openai-codex-oauth'
  throw new Error(`Login not supported for provider type '${providerType}'`)
}

const onProgress = (msg: string) => console.error(`… ${msg}`)
const onAuth = ({ url }: { url: string }) => {
  console.error(`Open in browser: ${url}`)
  tryOpen(url)
}

const loginInProcess = async (
  path: string,
  provider: string,
  nameArg: string | undefined
): Promise<string> => {
  const router = await loadRouter(path)
  const providerCfg = router.options.providers[provider]
  if (!providerCfg) {
    console.error(`Unknown provider: ${provider}`)
    process.exit(1)
  }

  if (nameArg !== undefined) {
    if (!providerCfg.accounts.some((a) => a.name === nameArg)) {
      await addAccount(router, provider, {
        type: accountTypeFor(providerCfg.type),
        name: nameArg
      })
    }
    await loginAccount(router, provider, nameArg, {
      onAuth,
      onPrompt: async () => '',
      onProgress
    })
    return nameArg
  }

  if (providerCfg.type !== 'openai-codex') {
    console.error(
      `Auto-discover login requires provider type 'openai-codex' (got '${providerCfg.type}'). Pass an account name.`
    )
    process.exit(1)
  }

  const { loginOpenAICodex, discoverEmail, ensureOpenAICodexOAuthRegistered } = await import(
    './auth/openai-codex-oauth'
  )
  ensureOpenAICodexOAuthRegistered()
  const creds = await loginOpenAICodex({
    onAuth,
    onPrompt: async () => '',
    onProgress
  })
  const email = discoverEmail(creds.access)

  if (!providerCfg.accounts.some((a) => a.name === email)) {
    await addAccount(router, provider, { type: 'openai-codex-oauth', name: email })
  }
  const account = router.options.providers[provider]?.accounts.find((a) => a.name === email)
  if (account !== undefined) {
    await persistLoginCredentials(router, provider, account, creds, 'openai-codex')
  }
  return email
}

let finalAccountName: string
if (adminUrl && adminKey) {
  if (!accountNameArg) {
    console.error('Account name is required when using the admin HTTP endpoint.')
    process.exit(1)
  }
  await loginViaHttp(adminUrl, adminKey, providerName, accountNameArg)
  finalAccountName = accountNameArg
} else {
  finalAccountName = await loginInProcess(configPath, providerName, accountNameArg)
}

console.error(`Logged in: ${providerName}/${finalAccountName}`)
process.exit(0)
