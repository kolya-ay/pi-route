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

const bash = (cli: CAC, verbs: Record<string, string[]>): string => {
  const { commands, globalFlags } = introspect(cli)
  const names = commands.map((c) => c.name).join(' ')
  const cases = commands
    .map((c) => `    ${c.name}) opts="${[...c.flags, ...globalFlags].join(' ')}" ;;`)
    .join('\n')
  const verbCases = Object.entries(verbs)
    .filter(([, names]) => names.length > 0)
    .map(
      ([cmd, names]) =>
        `      ${cmd}) COMPREPLY=( $(compgen -W "${names.join(' ')}" -- "$cur") ); return ;;`
    )
    .join('\n')
  return `# bash completion for pi-route
_pi_route() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${names}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi
  if [[ $COMP_CWORD -eq 2 ]]; then
    case "\${COMP_WORDS[1]}" in
${verbCases}
    esac
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

const zsh = (cli: CAC, verbs: Record<string, string[]>): string => {
  const { commands } = introspect(cli)
  const lines = commands.map((c) => `    '${c.name}:${c.description.replace(/'/g, '')}'`).join('\n')
  const verbBranches = Object.entries(verbs)
    .filter(([, names]) => names.length > 0)
    .map(([cmd, names]) => `      ${cmd}) compadd -- ${names.join(' ')} ;;`)
    .join('\n')
  return `#compdef pi-route
_pi_route() {
  local -a commands
  commands=(
${lines}
  )
  if (( CURRENT == 3 )); then
    case "\${words[2]}" in
${verbBranches}
    esac
    return
  fi
  _describe 'command' commands
}
_pi_route "$@"
`
}

const fish = (cli: CAC, verbs: Record<string, string[]>): string => {
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
  const verbLines = Object.entries(verbs)
    .filter(([, names]) => names.length > 0)
    .map(
      ([cmd, names]) =>
        `complete -c pi-route -n '__fish_seen_subcommand_from ${cmd}' -a '${names.join(' ')}'`
    )
    .join('\n')
  return `# fish completion for pi-route
complete -c pi-route -f
${cmdLines}
${flagLines}
${verbLines}
`
}

export const generateCompletion = (
  cli: CAC,
  shell: string,
  verbs: Record<string, string[]> = {}
): string => {
  switch (shell) {
    case 'bash':
      return bash(cli, verbs)
    case 'zsh':
      return zsh(cli, verbs)
    case 'fish':
      return fish(cli, verbs)
    default:
      throw new Error(`unknown shell "${shell}" — expected one of: bash, zsh, fish`)
  }
}
