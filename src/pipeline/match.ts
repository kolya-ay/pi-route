export type CompiledGlob = {
  pattern: string
  regex: RegExp
  negated: boolean
}

const ESC = /[.+^${}()|[\]\\-]/g
const escapeRegexChar = (c: string): string => c.replace(ESC, '\\$&')

export const compileGlob = (raw: string): CompiledGlob => {
  let pattern = raw
  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  let regex = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        regex += '(.*)'
        i += 2
      } else {
        regex += '([^/]*)'
        i += 1
      }
    } else if (ch === '?') {
      regex += '[^/]'
      i += 1
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) throw new Error(`Unterminated character class in glob: ${raw}`)
      regex += pattern.slice(i, end + 1)
      i = end + 1
    } else {
      regex += escapeRegexChar(ch)
      i += 1
    }
  }
  regex += '$'
  return { pattern: raw, regex: new RegExp(regex), negated }
}

export const matches = (glob: string, input: string): string[] | null => {
  const c = compileGlob(glob)
  const m = c.regex.exec(input)
  if (!m) return null
  return m.slice(1)
}

export const substitute = (template: string, captures: string[], model?: string): string => {
  return template.replace(/\$(\d)/g, (_, n: string) => {
    const idx = Number(n)
    if (idx === 0) {
      if (model === undefined) throw new Error(`unbound capture $0 in "${template}"`)
      return model
    }
    const v = captures[idx - 1]
    if (v === undefined) throw new Error(`unbound capture $${idx} in "${template}"`)
    return v
  })
}

export const exposeIncludes = (patterns: string[], input: string): boolean => {
  if (patterns.length === 0) return true
  let included = false
  for (const p of patterns) {
    const c = compileGlob(p)
    if (c.regex.test(input)) included = !c.negated
  }
  return included
}

export const hasGlobMetachars = (s: string): boolean => /[*?[]/.test(s)
