import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('model discovery keys', () => {
  type Materialized = { providers: Record<string, Record<string, unknown>> }

  it('defaults to off with the llm-deepseek timings', () => {
    const route = (routeWith({})() as Materialized).providers['acme-gateway']!
    expect(route['discoverModels']).toBe(false)
    expect(route['modelsTimeoutMs']).toBe(5000)
    expect(route['modelsMaxAgeMs']).toBe(600_000)
  })

  it('accepts an enabled route with no seed and zero max age', () => {
    expect(routeWith({ discoverModels: true, models: [], modelsMaxAgeMs: 0 })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ discoverModels: true, models: [] })() as Options) }).not.toThrow()
  })

  it('rejects bad timings at the schema and at service resolution', () => {
    expect(routeWith({ modelsTimeoutMs: 0 })).toThrow()
    expect(routeWith({ modelsTimeoutMs: -1 })).toThrow()
    expect(routeWith({ modelsMaxAgeMs: -1 })).toThrow()
    expect(routeWith({ modelsMaxAgeMs: 1.5 })).toThrow()
    const programmatic = (field: string, value: number): Options => ({
      providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models: [{ id: 'm' }], [field]: value } },
    })
    expect(() => { assertServiceable(programmatic('modelsTimeoutMs', 0)) }).toThrow(/modelsTimeoutMs must be a positive finite number/)
    expect(() => { assertServiceable(programmatic('modelsTimeoutMs', Number.POSITIVE_INFINITY)) }).toThrow(/modelsTimeoutMs/)
    expect(() => { assertServiceable(programmatic('modelsMaxAgeMs', -1)) }).toThrow(/modelsMaxAgeMs must be a non-negative safe integer/)
    expect(() => { assertServiceable(programmatic('modelsMaxAgeMs', 1.5)) }).toThrow(/modelsMaxAgeMs/)
  })

  it('requires a listable api and a resolvable baseURL', () => {
    expect(() => resolveProfiles({ gw: { api: 'google-generative-ai', baseURL: 'https://x.test', models: [{ id: 'm' }], discoverModels: true } }))
      .toThrow(/discoverModels.*"google-generative-ai" has no readable listing/)
    expect(() => resolveProfiles({ gw: { baseURL: 'https://x.test', models: [{ id: 'm' }], discoverModels: true } }))
      .toThrow(/discoverModels.*set api/)
    expect(() => resolveProfiles({ gw: { api: 'openai-completions', models: [{ id: 'm' }], discoverModels: true } }))
      .toThrow(/discoverModels.*needs a baseURL/)
    // A catalog route inherits the endpoint from the installed catalog; its protocol comes from the route when the catalog mixes several.
    expect(resolveProfiles({ openai: { api: 'openai-responses', discoverModels: true } }).get('openai')?.discovery)
      .toMatchObject({ api: 'openai-responses', baseURL: 'https://api.openai.com/v1' })
  })

  it('allows an empty models list only with discovery on', () => {
    expect(() => resolveProfiles({ gw: { api: 'openai-completions', baseURL: 'https://x.test', models: [] } })).toThrow(/resolves no models/)
    expect(resolveProfiles({ gw: { api: 'openai-completions', baseURL: 'https://x.test', models: [], discoverModels: true } }).get('gw')?.piProvider?.getModels())
      .toEqual([])
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})
