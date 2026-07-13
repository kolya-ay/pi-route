import { describe, expect, test } from 'bun:test'
import cac from 'cac'
import { generateCompletion } from './completion'

const sampleCli = () => {
  const cli = cac('pi-route')
  cli.option('-c, --config <path>', 'Config file path')
  cli.command('serve', 'Start the HTTP server').option('--port <port>', 'Listen port')
  cli.command('provider [...args]', 'Manage providers')
  return cli
}

describe('generateCompletion', () => {
  test('bash script lists commands and registers the function', () => {
    const out = generateCompletion(sampleCli(), 'bash')
    expect(out).toContain('complete -F _pi_route pi-route')
    expect(out).toContain('serve')
    expect(out).toContain('provider')
    expect(out).toContain('--config')
    expect(out).toContain('--port')
  })
  test('zsh script has a compdef header', () => {
    const out = generateCompletion(sampleCli(), 'zsh')
    expect(out).toContain('#compdef pi-route')
    expect(out).toContain('serve')
  })
  test('fish script uses complete -c pi-route', () => {
    const out = generateCompletion(sampleCli(), 'fish')
    expect(out).toContain('complete -c pi-route')
    expect(out).toContain('serve')
    expect(out).toContain('-l config')
  })
  test('unknown shell throws', () => {
    expect(() => generateCompletion(sampleCli(), 'tcsh')).toThrow(/bash.*zsh.*fish/)
  })
})
