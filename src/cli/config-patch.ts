// src/cli/config-patch.ts

import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser'
import { parse as parseTomlText, stringify as stringifyToml } from 'smol-toml'
import { Document, parseDocument } from 'yaml'

export type Edit = [path: (string | number)[], value: unknown]

const JSON_FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' }

// JSON/JSONC via offset-based text splices — unrelated keys, comments, and
// trailing commas outside the edited paths stay byte-stable.
export const patchJson = (existing: string, edits: Edit[]): string => {
  const base = existing.trim() === '' ? '{}' : existing
  const text = edits.reduce(
    (acc, [path, value]) =>
      applyEdits(acc, modify(acc, path, value, { formattingOptions: JSON_FORMAT })),
    base
  )
  return text.endsWith('\n') ? text : `${text}\n`
}

// YAML via the Document AST — comments attached to surviving nodes are re-emitted.
// (Not byte-stable for trailing/flow-inline comments; block comments survive.)
export const patchYaml = (existing: string, edits: Edit[]): string => {
  const doc = existing.trim() === '' ? new Document({}) : parseDocument(existing)
  for (const [path, value] of edits) doc.setIn(path, value)
  return doc.toString()
}

// Pure nested set — returns a new object; TOML paths are always string keys.
// Assumes object containers along the whole path (correct for current TOML
// edits, whose paths never descend through an array).
const setPath = (obj: unknown, path: (string | number)[], value: unknown): unknown => {
  if (path.length === 0) return value
  const [head, ...rest] = path
  const container = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : {}
  const child = container[head as string]
  return { ...container, [head as string]: setPath(child, rest, value) }
}

// TOML has no comment-preserving editor in JS: parse -> set -> stringify keeps
// other tables/keys as DATA but drops comments and reflows formatting.
export const patchToml = (existing: string, edits: Edit[]): string => {
  const base = existing.trim() === '' ? {} : (parseTomlText(existing) as Record<string, unknown>)
  const merged = edits.reduce<unknown>((acc, [path, value]) => setPath(acc, path, value), base)
  const text = stringifyToml(merged as Record<string, unknown>)
  return text.endsWith('\n') ? text : `${text}\n`
}
