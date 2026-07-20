// src/cli/verbs.ts

import { usageError } from './errors'

// `C` is whatever context the caller needs to do the work; verbs.ts only
// forwards it, so it stays free of config and env imports.
export type Verb<O, C> = {
  name: string
  arg?: string // '<name>' is required, '[agent]' is optional
  description: string
  flags: string[] // long flags valid for this verb, e.g. '--type'
  run: (ctx: C, arg: string | undefined, opts: O) => Promise<void>
}

// cac parses every flag on the parent command, so per-verb validation happens
// here. These are the root options, valid everywhere.
const GLOBAL_FLAGS = ['--config', '--state-dir', '--help', '--version']

const flagOf = (key: string): string => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

const passedFlags = (opts: Record<string, unknown>): string[] =>
  Object.entries(opts)
    .filter(
      ([key, value]) => value !== undefined && value !== false && key !== '--' && key.length > 1
    )
    .map(([key]) => flagOf(key))

export const renderVerbs = <O, C>(command: string, table: Verb<O, C>[]): string =>
  table
    .map((v) => {
      const head = `  pi-route ${command} ${v.name}${v.arg ? ` ${v.arg}` : ''}`
      const flags = v.flags.length > 0 ? `  [${v.flags.join(' ')}]` : ''
      return `${head.padEnd(44)}${v.description}${flags}`
    })
    .join('\n')

export const dispatchVerb = async <O extends Record<string, unknown>, C>(
  command: string,
  table: Verb<O, C>[],
  args: string[],
  opts: O,
  ctx: C
): Promise<void> => {
  const [name, arg] = args
  const verb = table.find((v) => v.name === name)
  if (!verb) {
    const what = name ? `unknown ${command} verb "${name}"` : `pi-route ${command} needs a verb`
    throw usageError(`${what}\n\n${renderVerbs(command, table)}`)
  }
  if (verb.arg?.startsWith('<') && !arg) {
    throw usageError(`pi-route ${command} ${verb.name} requires ${verb.arg}`)
  }
  const stray = passedFlags(opts).filter(
    (f) => !verb.flags.includes(f) && !GLOBAL_FLAGS.includes(f)
  )
  if (stray.length > 0) {
    throw usageError(
      `${stray.join(', ')} ${stray.length > 1 ? 'are not options' : 'is not an option'} of "${command} ${verb.name}"\n\n${renderVerbs(command, table)}`
    )
  }
  await verb.run(ctx, arg, opts)
}
