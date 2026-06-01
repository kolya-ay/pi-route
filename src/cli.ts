#!/usr/bin/env bun
// src/cli.ts

import { addAccount, loginAccount } from './admin/accounts'
import { loadRouter } from './app'

const verb = Bun.argv[2]
const providerName = Bun.argv[3]
const accountName = Bun.argv[4]

if (verb !== 'login' || !providerName || !accountName) {
  console.error('Usage: pi-route login <provider> <account-name>')
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

const loginInProcess = async (path: string, provider: string, name: string): Promise<void> => {
  const router = await loadRouter(path)
  const providerCfg = router.options.providers[provider]
  if (!providerCfg) {
    console.error(`Unknown provider: ${provider}`)
    process.exit(1)
  }
  if (!providerCfg.accounts.some((a) => a.name === name)) {
    await addAccount(router, provider, { type: 'antigravity-oauth', name })
  }
  await loginAccount(router, provider, name, {
    onAuth: ({ url }) => {
      console.error(`Open in browser: ${url}`)
      tryOpen(url)
    },
    onPrompt: async () => '',
    onProgress: (msg) => console.error(`… ${msg}`)
  })
}

if (adminUrl && adminKey) {
  await loginViaHttp(adminUrl, adminKey, providerName, accountName)
} else {
  await loginInProcess(configPath, providerName, accountName)
}

console.error(`Logged in: ${providerName}/${accountName}`)
process.exit(0)
