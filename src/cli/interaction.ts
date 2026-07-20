import { createInterface } from 'node:readline/promises'
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'

type SelectOption = { id: string; label: string; description?: string }

// Bun's global prompt() reads stdin synchronously, which starves the OAuth
// callback server that pi-ai races against this prompt. readline/promises
// keeps the loop free and honours the per-prompt abort signal.
const readLine = async (query: string, signal?: AbortSignal): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(query, signal ? { signal } : {})
  } catch {
    return '' // aborted: the callback server won, and the value is discarded
  } finally {
    rl.close()
  }
}

// Empty input takes the first option, so "press Enter" means the default.
export const selectAnswer = (options: readonly SelectOption[], input: string): string => {
  const value = input.trim()
  const first = options[0]
  if (!first) throw new Error('select prompt has no options')
  if (value === '') return first.id
  const index = Number(value)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return (options[index - 1] as SelectOption).id
  }
  const byId = options.find((o) => o.id === value)
  if (byId) return byId.id
  throw new Error(`invalid selection: ${value}`)
}

const selectQuery = (message: string, options: readonly SelectOption[]): string =>
  [
    message,
    ...options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`),
    `[1-${options.length}, Enter for 1] `
  ].join('\n')

const query = (prompt: AuthPrompt): string =>
  prompt.type === 'select'
    ? selectQuery(prompt.message, prompt.options)
    : `${prompt.message}${'placeholder' in prompt && prompt.placeholder ? ` (${prompt.placeholder})` : ''} `

const tryOpen = (url: string): void => {
  for (const opener of ['xdg-open', 'open']) {
    try {
      Bun.spawn([opener, url]).exited.catch(() => {})
      return
    } catch {
      // try next opener
    }
  }
}

// pi-ai login interaction over stdin/stderr. Prompts render by type; `select`
// returns the chosen option id, which is what pi-ai's flows compare against.
export const stdinInteraction = (): AuthInteraction => ({
  notify(event: AuthEvent): void {
    if (event.type === 'auth_url') {
      console.error(`Open in browser: ${event.url}`)
      if (event.instructions) console.error(event.instructions)
      tryOpen(event.url)
    } else if (event.type === 'device_code') {
      console.error(`Enter code ${event.userCode} at ${event.verificationUri}`)
    } else {
      console.error(`… ${event.message}`)
    }
  },
  async prompt(prompt: AuthPrompt): Promise<string> {
    const answer = await readLine(query(prompt), prompt.signal)
    return prompt.type === 'select' ? selectAnswer(prompt.options, answer) : answer
  }
})
