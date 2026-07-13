import type { CAC } from 'cac'

// cac's rawName carries args (`provider [...args]`); the leading token is the name.
const commandName = (rawName: string): string => rawName.split(/\s/)[0] as string

// `-c, --config <path>` → ['-c', '--config']; drops the `<value>` placeholder.
const flagNames = (rawName: string): string[] =>
  rawName
    .split(',')
    .map((s) => s.trim().split(/\s/)[0] as string)
    .filter((s) => s.startsWith('-'))

type Cmd = { name: string; description: string; flags: string[] }

const introspect = (cli: CAC): { commands: Cmd[]; globalFlags: string[] } => {
  const globalFlags = cli.globalCommand.options.flatMap((o) => flagNames(o.rawName))
  const commands = cli.commands.map((c) => ({
    name: commandName(c.rawName),
    description: c.description,
    flags: c.options.flatMap((o) => flagNames(o.rawName))
  }))
  return { commands, globalFlags }
}

const bash = (cli: CAC): string => {
  const { commands, globalFlags } = introspect(cli)
  const names = commands.map((c) => c.name).join(' ')
  const cases = commands
    .map((c) => `    ${c.name}) opts="${[...c.flags, ...globalFlags].join(' ')}" ;;`)
    .join('\n')
  return `# bash completion for pi-route
_pi_route() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${names}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi
  local opts="${globalFlags.join(' ')}"
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _pi_route pi-route
`
}

const zsh = (cli: CAC): string => {
  const { commands } = introspect(cli)
  const lines = commands.map((c) => `    '${c.name}:${c.description.replace(/'/g, '')}'`).join('\n')
  return `#compdef pi-route
_pi_route() {
  local -a commands
  commands=(
${lines}
  )
  _describe 'command' commands
}
_pi_route "$@"
`
}

const fish = (cli: CAC): string => {
  const { commands, globalFlags } = introspect(cli)
  const cmdLines = commands
    .map(
      (c) =>
        `complete -c pi-route -n __fish_use_subcommand -a ${c.name} -d '${c.description.replace(/'/g, '')}'`
    )
    .join('\n')
  const flagLines = globalFlags
    .filter((f) => f.startsWith('--'))
    .map((f) => `complete -c pi-route -l ${f.slice(2)}`)
    .join('\n')
  return `# fish completion for pi-route
complete -c pi-route -f
${cmdLines}
${flagLines}
`
}

export const generateCompletion = (cli: CAC, shell: string): string => {
  switch (shell) {
    case 'bash':
      return bash(cli)
    case 'zsh':
      return zsh(cli)
    case 'fish':
      return fish(cli)
    default:
      throw new Error(`unknown shell "${shell}" — expected one of: bash, zsh, fish`)
  }
}
