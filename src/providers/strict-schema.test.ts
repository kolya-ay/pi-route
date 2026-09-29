// src/providers/strict-schema.test.ts

import { describe, expect, it } from 'bun:test'

import { asRecord, StructuredOutputRequestError } from '../structured-output'

import { collapseNullable, inlineDefs, stripUnsupported, toStrictToolSchema } from './strict-schema'

describe('inlineDefs', () => {
  it('leaves a schema with no refs untouched', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false
    }
    expect(inlineDefs(schema)).toEqual(schema)
  })

  it('inlines a nested struct through properties and drops $defs', () => {
    const result = inlineDefs({
      type: 'object',
      properties: { inner: { $ref: '#/$defs/Inner' } },
      required: ['inner'],
      additionalProperties: false,
      $defs: {
        Inner: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
          additionalProperties: false
        }
      }
    })
    expect(result).toEqual({
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
          additionalProperties: false
        }
      },
      required: ['inner'],
      additionalProperties: false
    })
  })

  it('inlines a ref under array items', () => {
    const result = inlineDefs({
      type: 'object',
      properties: { list: { type: 'array', items: { $ref: '#/$defs/Item' } } },
      required: ['list'],
      $defs: { Item: { type: 'object', properties: { n: { type: 'number' } } } }
    })
    expect(result.properties).toEqual({
      list: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } } } }
    })
  })

  it('inlines inside anyOf, the shape Option<Struct> arrives as', () => {
    const result = inlineDefs({
      type: 'object',
      properties: {
        maybe: { anyOf: [{ $ref: '#/$defs/S' }, { type: 'null' }] }
      },
      $defs: { S: { type: 'object', properties: { q: { type: 'string' } } } }
    })
    expect(result.properties).toEqual({
      maybe: {
        anyOf: [{ type: 'object', properties: { q: { type: 'string' } } }, { type: 'null' }]
      }
    })
  })

  it('merges sibling keywords over the definition, siblings winning', () => {
    const result = inlineDefs({
      type: 'object',
      properties: {
        s: { $ref: '#/$defs/S', description: 'from the use site' }
      },
      $defs: {
        S: { type: 'object', description: 'from the definition', properties: {} }
      }
    })
    expect(result.properties).toEqual({
      s: { type: 'object', description: 'from the use site', properties: {} }
    })
  })

  it('resolves #/definitions/ as well as #/$defs/', () => {
    const result = inlineDefs({
      type: 'object',
      properties: { a: { $ref: '#/definitions/A' } },
      definitions: { A: { type: 'string' } }
    })
    expect(result).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('throws on a recursive ref instead of recursing forever', () => {
    expect(() =>
      inlineDefs({
        type: 'object',
        properties: { node: { $ref: '#/$defs/Node' } },
        $defs: {
          Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } }
        }
      })
    ).toThrow(StructuredOutputRequestError)
  })

  it('throws on a non-local ref', () => {
    expect(() =>
      inlineDefs({
        type: 'object',
        properties: { a: { $ref: 'https://example.com/schema.json#/A' } }
      })
    ).toThrow(/non-local/)
  })

  it('throws on a ref with no matching definition', () => {
    expect(() =>
      inlineDefs({ type: 'object', properties: { a: { $ref: '#/$defs/Missing' } }, $defs: {} })
    ).toThrow(/no definition/)
  })

  it('stops a doubling $defs chain before it expands, not after', () => {
    // Each definition references the next twice, so the inlined tree doubles per
    // level: ~2KB of input, 2^18 nodes of output. `trail` does not catch this — it
    // bounds depth, and this is width. A budget measured on the finished tree would
    // only throw after the expansion had already run.
    const levels = 18
    const $defs = Object.fromEntries(
      Array.from({ length: levels }, (_, n) => [
        `D${n}`,
        {
          type: 'object',
          properties: {
            x: { $ref: `#/$defs/D${n + 1}` },
            y: { $ref: `#/$defs/D${n + 1}` }
          }
        }
      ])
    )
    const schema = {
      type: 'object',
      properties: { root: { $ref: '#/$defs/D0' } },
      $defs: { ...$defs, [`D${levels}`]: { type: 'string' } }
    }

    const started = Date.now()
    expect(() => inlineDefs(schema)).toThrow(/expands too wide/)
    // The guard is only worth having if it fires during the walk; a post-hoc check
    // on this input takes seconds and allocates hundreds of megabytes first.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('accepts a schema that is merely large', () => {
    // Wide but flat: 400 uses of one small definition is a big schema, not a
    // runaway one, and it must still go through.
    const result = inlineDefs({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, n) => [`p${n}`, { $ref: '#/$defs/Small' }])
      ),
      $defs: { Small: { type: 'object', properties: { a: { type: 'string' } } } }
    })
    expect(Object.keys(result.properties as Record<string, unknown>)).toHaveLength(400)
  })
})

describe('nullable array elements', () => {
  it('refuses Vec<Option<Struct>> rather than quietly forbidding null elements', () => {
    // items: anyOf [Struct, null] has no `required` list for pi-ai to re-wrap from,
    // so collapsing it would narrow the schema instead of preserving it.
    expect(() =>
      collapseNullable({
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: {
              anyOf: [{ type: 'object', properties: { q: { type: 'string' } } }, { type: 'null' }]
            }
          }
        },
        required: ['list']
      })
    ).toThrow(/nullable object or array as an array element/)
  })

  it('leaves a nullable scalar element alone', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
      },
      required: ['list']
    }
    expect(collapseNullable(schema)).toEqual(schema)
  })
})

describe('collapseNullable', () => {
  it('collapses anyOf: [object, null] and drops the key from required', () => {
    expect(
      collapseNullable({
        type: 'object',
        properties: {
          keep: { type: 'string' },
          maybe: {
            anyOf: [
              { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
              { type: 'null' }
            ]
          }
        },
        required: ['keep', 'maybe'],
        additionalProperties: false
      })
    ).toEqual({
      type: 'object',
      properties: {
        keep: { type: 'string' },
        maybe: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
      },
      required: ['keep'],
      additionalProperties: false
    })
  })

  it('keeps sibling keywords from the anyOf node on the collapsed variant', () => {
    const result = collapseNullable({
      type: 'object',
      properties: {
        maybe: {
          description: 'the optional one',
          anyOf: [{ type: 'object', properties: {} }, { type: 'null' }]
        }
      },
      required: ['maybe']
    })
    expect(result.properties).toEqual({
      maybe: { type: 'object', properties: {}, description: 'the optional one' }
    })
    expect(result.required).toEqual([])
  })

  it('leaves a scalar nullable union alone — the strict gate accepts those', () => {
    const schema = {
      type: 'object',
      properties: { s: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['s']
    }
    expect(collapseNullable(schema)).toEqual(schema)
  })

  it('collapses inside array items', () => {
    const result = collapseNullable({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              maybe: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] }
            },
            required: ['maybe']
          }
        }
      },
      required: ['list']
    })
    const properties = asRecord(result.properties)
    const list = asRecord(properties?.list)
    expect(list?.items).toEqual({
      type: 'object',
      properties: { maybe: { type: 'object', properties: {} } },
      required: []
    })
  })

  it('leaves a three-variant anyOf alone', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { anyOf: [{ type: 'object' }, { type: 'string' }, { type: 'null' }] }
      },
      required: ['x']
    }
    expect(collapseNullable(schema)).toEqual(schema)
  })
})

describe('toStrictToolSchema', () => {
  it('inlines then collapses, so Option<Struct> survives both gates', () => {
    const { schema: result, dropped } = toStrictToolSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Response',
      type: 'object',
      properties: {
        proposals: { type: 'array', items: { $ref: '#/$defs/Proposal' } }
      },
      required: ['proposals'],
      additionalProperties: false,
      $defs: {
        Proposal: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            evidence: { anyOf: [{ $ref: '#/$defs/Evidence' }, { type: 'null' }] }
          },
          required: ['path', 'evidence'],
          additionalProperties: false
        },
        Evidence: {
          type: 'object',
          properties: { quote: { type: 'string' } },
          required: ['quote'],
          additionalProperties: false
        }
      }
    })
    expect(result.$defs).toBeUndefined()
    const properties = asRecord(result.properties)
    const proposals = asRecord(properties?.proposals)
    const item = asRecord(proposals?.items)
    expect(item?.required).toEqual(['path'])
    const itemProperties = asRecord(item?.properties)
    expect(itemProperties?.evidence).toEqual({
      type: 'object',
      properties: { quote: { type: 'string' } },
      required: ['quote'],
      additionalProperties: false
    })
    // Unknown keywords pass through: pi-ai's gate is a closed blocklist.
    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(result.title).toBe('Response')
    expect(dropped).toEqual([])
  })
})

describe('stripUnsupported', () => {
  it('drops the numeric keywords Anthropic refuses and names them', () => {
    const { schema, dropped } = stripUnsupported({
      type: 'object',
      properties: {
        n: { type: 'integer', format: 'uint32', minimum: 0, maximum: 10 },
        f: { type: 'number', format: 'double', exclusiveMinimum: 0, multipleOf: 2 }
      },
      required: ['n', 'f']
    })
    expect(schema.properties).toEqual({
      n: { type: 'integer', format: 'uint32' },
      f: { type: 'number', format: 'double' }
    })
    expect([...dropped].sort()).toEqual(['exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'])
  })

  it('keeps everything Anthropic accepts', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Keep',
      type: 'object',
      properties: { s: { type: 'string', minLength: 1, pattern: '^[a-z]+$' } },
      required: ['s']
    }
    const result = stripUnsupported(schema)
    expect(result.schema).toEqual(schema)
    expect(result.dropped).toEqual([])
  })

  it('strips through items and anyOf', () => {
    const { schema, dropped } = stripUnsupported({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'integer', minimum: 1 } },
        maybe: { anyOf: [{ type: 'number', maximum: 5 }, { type: 'null' }] }
      }
    })
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.list?.items).toEqual({ type: 'integer' })
    expect(properties.maybe?.anyOf).toEqual([{ type: 'number' }, { type: 'null' }])
    expect([...dropped].sort()).toEqual(['maximum', 'minimum'])
  })

  it('reports each dropped keyword once, however many times it appears', () => {
    const { dropped } = stripUnsupported({
      type: 'object',
      properties: {
        a: { type: 'integer', minimum: 0 },
        b: { type: 'integer', minimum: 0 },
        c: { type: 'integer', minimum: 0 }
      }
    })
    expect(dropped).toEqual(['minimum'])
  })
})
