// src/providers/strict-schema.ts

import { asRecord, StructuredOutputRequestError } from '../structured-output'

// pi-ai's strict gate (dist/api/constrained-sampling.js) rejects `$ref`, `$defs` and
// `definitions` as keywords, so a schemars-shaped schema can only reach a constrained
// tool with its refs resolved in place. Native routes keep the schema verbatim —
// cerebras and OpenRouter both accept `$defs` themselves.

const LOCAL_REF = /^#\/(?:\$defs|definitions)\/(.+)$/

// Inlining duplicates a definition at every use site, so a definition referenced twice
// per level doubles per level: a couple of kilobytes of input can expand into hundreds
// of megabytes. `trail` bounds depth but not width, and measuring the finished tree
// would only run after the expansion it is meant to prevent — by then the walk has
// already blocked the event loop. So the budget is spent per node, during the walk.
const MAX_NODES = 20_000

const spend = (budget: { spent: number }): void => {
  budget.spent += 1
  if (budget.spent > MAX_NODES) {
    throw new StructuredOutputRequestError(
      `inlining $defs exceeds ${MAX_NODES} nodes; the schema expands too wide to enforce`
    )
  }
}

// The only positions where a ref can sit and change the outcome. `oneOf`, `allOf`,
// `prefixItems`, `not` and schema-valued `additionalProperties` are rejected by the
// strict gate as keywords whether or not they hold refs, so walking them would add
// surface without changing a single verdict. Both passes that descend the tree share
// this, so that decision lives in exactly one place.
const mapChildren = (
  schema: Record<string, unknown>,
  fn: (node: unknown) => unknown
): Record<string, unknown> => {
  const properties = asRecord(schema.properties)
  const { anyOf } = schema
  return {
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [key, fn(value)])
          )
        }
      : {}),
    ...(schema.items !== undefined ? { items: fn(schema.items) } : {}),
    ...(Array.isArray(anyOf) ? { anyOf: anyOf.map(fn) } : {})
  }
}

const resolve = (
  node: unknown,
  defs: Record<string, unknown>,
  trail: readonly string[],
  budget: { spent: number }
): unknown => {
  const schema = asRecord(node)
  if (!schema) return node
  spend(budget)

  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return { ...schema, ...mapChildren(schema, (child) => resolve(child, defs, trail, budget)) }
  }

  const name = LOCAL_REF.exec(ref)?.[1]
  if (name === undefined) {
    throw new StructuredOutputRequestError(`cannot inline non-local $ref "${ref}"`)
  }
  if (trail.includes(name)) {
    throw new StructuredOutputRequestError(
      `cannot inline recursive $ref "${ref}" (${[...trail, name].join(' -> ')})`
    )
  }
  const target = asRecord(defs[name])
  if (!target) {
    throw new StructuredOutputRequestError(`$ref "${ref}" has no definition`)
  }
  // schemars 1 emits {"$ref": "#/$defs/X", "description": "…"}; the use site's own
  // keywords describe this field, so they win over the shared definition's.
  const { $ref: _ref, ...siblings } = schema
  return resolve({ ...target, ...siblings }, defs, [...trail, name], budget)
}

export const inlineDefs = (schema: Record<string, unknown>): Record<string, unknown> => {
  const defs = { ...asRecord(schema.definitions), ...asRecord(schema.$defs) }
  const { $defs: _defs, definitions: _definitions, ...root } = schema
  return asRecord(resolve(root, defs, [], { spent: 0 })) ?? root
}

const isStructured = (node: Record<string, unknown>): boolean =>
  node.type === 'object' ||
  node.type === 'array' ||
  node.properties !== undefined ||
  node.items !== undefined

// The one union shape the strict gate refuses and schemars 1 emits constantly:
// Option<Struct> as anyOf: [Struct, {"type": "null"}]. Scalar nullable unions pass
// the gate untouched, so they are left exactly as they came.
const structuredNullable = (node: Record<string, unknown>): Record<string, unknown> | undefined => {
  const { anyOf } = node
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return undefined
  const [first, second] = anyOf.map(asRecord)
  // Exactly one null variant: [null, null] picks `second` and fails isStructured,
  // [Struct, Struct] picks neither.
  const only = first?.type === 'null' ? second : second?.type === 'null' ? first : undefined
  if (!only || !isStructured(only)) return undefined
  const { anyOf: _anyOf, ...siblings } = node
  return { ...only, ...siblings }
}

// Dropping a collapsed key from `required` is what makes this equivalent rather than
// a loosening: pi-ai wraps every non-required property back into
// anyOf: [property, {"type": "null"}] after its own validation, reproducing the
// original shape on the wire.
//
// That re-wrap only happens for object properties, which is why the same collapse
// cannot be applied to an `items` node — see refuseNullableItems below.
export const collapseNullable = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = asRecord(schema.properties)
  const items = asRecord(schema.items)
  const withItems = items ? { items: collapseNullable(refuseNullableItems(items)) } : {}

  if (!properties) return { ...schema, ...withItems }

  const entries = Object.entries(properties).map(([key, value]) => {
    const node = asRecord(value)
    if (!node) return { key, value, collapsed: false }
    const bare = structuredNullable(node)
    return { key, value: collapseNullable(bare ?? node), collapsed: bare !== undefined }
  })
  const dropped = new Set(entries.filter((entry) => entry.collapsed).map((entry) => entry.key))

  return {
    ...schema,
    ...withItems,
    properties: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((key) => !dropped.has(key as string)) }
      : {})
  }
}

// `Vec<Option<Struct>>` arrives as items: {anyOf: [Struct, null]}. Collapsing it the
// way a property is collapsed would be a real narrowing, not an equivalence: an array
// element has no `required` list to drop the key from, so pi-ai never re-wraps it, and
// the array would quietly stop accepting null elements. The strict gate has no way to
// express a nullable struct element at all, so refuse and say why rather than silently
// change what the caller asked for — the same contract phase 1 set.
const refuseNullableItems = (items: Record<string, unknown>): Record<string, unknown> => {
  if (!structuredNullable(items)) return items
  throw new StructuredOutputRequestError(
    'cannot enforce a nullable object or array as an array element ' +
      '(items: anyOf [schema, null]); this backend has no way to express it'
  )
}

// Anthropic's tool `input_schema` validator refuses the numeric range/step family
// one keyword at a time ("For 'integer' type, property 'minimum' is not
// supported"). Verified individually against cc/claude-haiku-4-5; `format`,
// `minLength` and `pattern` are accepted and stay. schemars 1 emits `minimum: 0`
// for every unsigned integer, so this is not an edge case.
const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf'
])

// `seen` accumulates across the whole walk and is the one thing written here; the
// keyword test stays a plain lookup.
const stripNode = (node: unknown, seen: Set<string>): unknown => {
  const schema = asRecord(node)
  if (!schema) return node

  const kept = Object.entries(schema).filter(([key]) => {
    if (!UNSUPPORTED_KEYWORDS.has(key)) return true
    seen.add(key)
    return false
  })

  return {
    ...Object.fromEntries(kept),
    ...mapChildren(schema, (child) => stripNode(child, seen))
  }
}

// Returns the schema alongside the keywords it had to drop. The pair is the point:
// dropping a constraint the caller asked for is a weakening, and the caller of this
// module records `dropped` so that weakening is observable instead of silent.
export const stripUnsupported = (
  schema: Record<string, unknown>
): { schema: Record<string, unknown>; dropped: string[] } => {
  const seen = new Set<string>()
  const stripped = asRecord(stripNode(schema, seen)) ?? schema
  return { schema: stripped, dropped: [...seen] }
}

// The whole normalization, in the order that matters: refs resolve first so the
// collapse sees real variants rather than `$ref` nodes, and the strip runs last so
// it reaches keywords that arrived inside a definition.
export const toStrictToolSchema = (
  schema: Record<string, unknown>
): { schema: Record<string, unknown>; dropped: string[] } =>
  stripUnsupported(collapseNullable(inlineDefs(schema)))
