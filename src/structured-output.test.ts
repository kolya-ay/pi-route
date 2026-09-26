// src/structured-output.test.ts

import { describe, expect, test } from 'bun:test'

import { parseStructuredOutput, StructuredOutputRequestError } from './structured-output'

const schema = {
  type: 'object',
  properties: { capital: { type: 'string' } },
  required: ['capital'],
  additionalProperties: false
}

const chatBody = (json_schema: unknown, rest: Record<string, unknown> = {}) => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  response_format: { type: 'json_schema', json_schema },
  ...rest
})

const responsesBody = (format: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  model: 'm',
  input: 'hi',
  text: { format: { type: 'json_schema', ...format } },
  ...rest
})

describe('parseStructuredOutput', () => {
  test('normalizes the chat and responses syntaxes to the same constraint', () => {
    const expected = { name: 'capital', description: 'Capital response', schema }

    expect(
      parseStructuredOutput(
        'openai',
        chatBody({ name: 'capital', description: 'Capital response', strict: true, schema })
      )
    ).toEqual(expected)

    expect(
      parseStructuredOutput(
        'responses',
        responsesBody({ name: 'capital', description: 'Capital response', schema })
      )
    ).toEqual(expected)
  })

  test('requires strict enforcement even when the client omits or disables it', () => {
    const omitted = parseStructuredOutput('openai', chatBody({ name: 'capital', schema }))
    const disabled = parseStructuredOutput(
      'openai',
      chatBody({ name: 'capital', strict: false, schema })
    )
    expect(omitted).toEqual({ name: 'capital', schema })
    expect(disabled).toEqual({ name: 'capital', schema })
  })

  test('returns undefined when the request carries no structured output', () => {
    expect(parseStructuredOutput('openai', { model: 'm', messages: [] })).toBeUndefined()
    expect(parseStructuredOutput('responses', { model: 'm', input: 'hi' })).toBeUndefined()
    expect(parseStructuredOutput('responses', { model: 'm', text: {} })).toBeUndefined()
  })

  test('ignores anthropic requests, which have no structured-output syntax', () => {
    expect(
      parseStructuredOutput('anthropic', {
        model: 'm',
        response_format: { type: 'json_schema', json_schema: { name: 'capital', schema } }
      })
    ).toBeUndefined()
  })

  test('rejects structured-output modes other than json_schema', () => {
    expect(() =>
      parseStructuredOutput('openai', { model: 'm', response_format: { type: 'json_object' } })
    ).toThrow(StructuredOutputRequestError)
    expect(() =>
      parseStructuredOutput('responses', { model: 'm', text: { format: { type: 'text' } } })
    ).toThrow(/json_schema/)
  })

  test('rejects a missing or blank schema name', () => {
    expect(() => parseStructuredOutput('openai', chatBody({ schema }))).toThrow(/name/)
    expect(() => parseStructuredOutput('openai', chatBody({ name: '  ', schema }))).toThrow(/name/)
    expect(() => parseStructuredOutput('responses', responsesBody({ schema }))).toThrow(/name/)
  })

  test('rejects a schema that is not a plain object', () => {
    expect(() => parseStructuredOutput('openai', chatBody({ name: 'capital' }))).toThrow(/schema/)
    expect(() =>
      parseStructuredOutput('openai', chatBody({ name: 'capital', schema: [] }))
    ).toThrow(/schema/)
    expect(() =>
      parseStructuredOutput('openai', chatBody({ name: 'capital', schema: null }))
    ).toThrow(/schema/)
  })

  test('rejects a malformed json_schema wrapper', () => {
    expect(() =>
      parseStructuredOutput('openai', { model: 'm', response_format: { type: 'json_schema' } })
    ).toThrow(StructuredOutputRequestError)
  })

  test('rejects a non-string description', () => {
    expect(() =>
      parseStructuredOutput('openai', chatBody({ name: 'capital', description: 7, schema }))
    ).toThrow(/description/)
  })

  test('rejects structured output combined with client tools', () => {
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: {} } }]
    expect(() =>
      parseStructuredOutput('openai', chatBody({ name: 'capital', schema }, { tools }))
    ).toThrow(/cannot be combined with tools/)
    expect(() =>
      parseStructuredOutput('responses', responsesBody({ name: 'capital', schema }, { tools }))
    ).toThrow(/cannot be combined with tools/)
  })

  test('accepts an empty tools array alongside structured output', () => {
    expect(
      parseStructuredOutput('openai', chatBody({ name: 'capital', schema }, { tools: [] }))
    ).toEqual({ name: 'capital', schema })
  })
})
