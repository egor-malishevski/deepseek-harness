/** Route listing cache: single-flight, bounded first wait, retention, rescope, refresh, and disposal. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ModelListingRequest } from '../src/discovery.ts'
import { LISTING_TIMEOUT, RouteListingCache } from '../src/listing.ts'
import type { ListingSettings } from '../src/listing.ts'

afterEach(() => { vi.useRealTimers() })

const models = (...ids: string[]): LlmDiscoveredModel[] => ids.map(id => ({ id, name: id }))

function harness(timeoutMs = 60_000, maxAgeMs = 100, wallClock = false) {
  let clock = 0
  const loads: Array<{ request: ModelListingRequest; signal: AbortSignal; settle: PromiseWithResolvers<LlmDiscoveredModel[]> }> = []
  const info = vi.fn()
  const warn = vi.fn()
  const changed = vi.fn()
  const settings: { -readonly [K in keyof ListingSettings]: ListingSettings[K] } = { timeoutMs, maxAgeMs }
  const state: { request: ModelListingRequest | undefined; fail: unknown; honorAbort: boolean } = {
    request: { api: 'openai-completions', baseURL: 'https://gw.test/v1', headers: { 'X-A': '1' }, apiKey: 'k' },
    fail: undefined,
    honorAbort: true,
  }
  const cache = new RouteListingCache({
    settings: () => {
      if (state.fail !== undefined) throw state.fail
      return settings
    },
    request: () => Promise.resolve(state.request),
    load: (request, signal) => {
      const settle = Promise.withResolvers<LlmDiscoveredModel[]>()
      // A transport that ignores cancellation still settles later, which the cache must discard.
      if (state.honorAbort) signal.addEventListener('abort', () => { settle.reject(signal.reason) }, { once: true })
      loads.push({ request, signal, settle })
      return settle.promise
    },
    // Fake timers move Date.now() with the timers, which is what scheduled refreshes read.
    now: () => wallClock ? Date.now() : clock,
    info,
    warn,
    changed,
  })
  onTestFinished(() => cache.dispose())
  return {
    cache, loads, info, warn, changed, settings, state,
    flush: () => new Promise(resolve => setImmediate(resolve)),
    advance: (ms: number) => { clock += ms },
  }
}

it('loads nothing while the route has no usable request', async () => {
  const { cache, loads, state } = harness()
  state.request = undefined
  await cache.access()
  expect(loads).toEqual([])
  expect(cache.current()).toBeUndefined()
})

it('shares one first load between concurrent callers and reports it', async () => {
  const { cache, loads, info, changed, flush } = harness()
  const first = cache.access()
  const second = cache.access()
  await flush()
  expect(loads).toHaveLength(1)
  expect(loads[0]!.request.headers).toEqual({ 'X-A': '1' })
  loads[0]!.settle.resolve(models('a'))
  await Promise.all([first, second])
  expect(cache.current()).toEqual(models('a'))
  expect(changed).toHaveBeenCalledExactlyOnceWith(undefined, models('a'))
  expect(info).toHaveBeenCalledExactlyOnceWith('model listing from https://gw.test/v1/models loaded 1 model(s)')
})

it('bounds the first wait by the request deadline and serves no listing after a failure', async () => {
  const { cache, loads, warn, changed } = harness(5)
  await cache.access()
  expect(timeoutOf(loads[0]!.signal, LISTING_TIMEOUT)?.timeoutMs).toBe(5)
  expect(cache.current()).toBeUndefined()
  expect(changed).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('keeping the configured models'))
})

it('lets a caller abandon its wait without cancelling the shared load', async () => {
  const { cache, loads, flush } = harness()
  const abandon = new AbortController()
  const waiting = cache.access(abandon.signal)
  await flush()
  abandon.abort(new Error('caller left'))
  await expect(waiting).rejects.toThrow('caller left')
  expect(loads[0]!.signal.aborted).toBe(false)
  await expect(cache.access(abandon.signal)).rejects.toThrow('caller left')
  loads[0]!.settle.resolve(models('a'))
  await flush()
  expect(cache.current()).toEqual(models('a'))
})

it('keeps the last good listing on error or empty data and warns once per streak', async () => {
  const { cache, loads, warn, changed, advance, flush } = harness()
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a', 'b'))
  await first

  advance(100)
  await cache.access()
  await flush()
  loads[1]!.settle.reject(new Error('down'))
  await flush()
  advance(100)
  await cache.access()
  await flush()
  loads[2]!.settle.resolve([])
  await flush()
  expect(cache.current()).toEqual(models('a', 'b'))
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping the previous listing'))

  advance(100)
  await cache.access()
  await flush()
  loads[3]!.settle.resolve(models('a', 'b'))
  await flush()
  // An identical listing is not a change; a recovered streak warns again next time.
  expect(changed).toHaveBeenCalledTimes(1)
  advance(100)
  await cache.access()
  await flush()
  loads[4]!.settle.reject(new Error('down again'))
  await flush()
  expect(warn).toHaveBeenCalledTimes(2)
})

it('publishes a changed listing with the previous one', async () => {
  const { cache, loads, changed, advance, flush } = harness()
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a', 'b'))
  await first
  advance(100)
  await cache.access()
  await flush()
  loads[1]!.settle.resolve(models('a'))
  await flush()
  expect(changed).toHaveBeenLastCalledWith(models('a', 'b'), models('a'))
})

it('does not refresh a fresh listing', async () => {
  const { cache, loads, advance, flush } = harness()
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a'))
  await first
  advance(99)
  await cache.access()
  expect(loads).toHaveLength(1)
})

it('refreshes on every access when the max age is zero, and runs no timer', async () => {
  vi.useFakeTimers()
  const { cache, loads } = harness(60_000, 0, true)
  const first = cache.access()
  await vi.advanceTimersByTimeAsync(0)
  loads[0]!.settle.resolve(models('a'))
  await first
  expect(vi.getTimerCount()).toBe(0)
  await cache.access()
  await vi.advanceTimersByTimeAsync(0)
  expect(loads).toHaveLength(2)
  loads[1]!.settle.resolve(models('a'))
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('discards the listing when the endpoint or credentials change', async () => {
  const { cache, loads, changed, state, flush } = harness()
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a'))
  await first

  state.request = { ...state.request!, headers: { 'X-A': '2' } }
  const second = cache.access()
  await flush()
  expect(cache.current()).toBeUndefined()
  expect(changed).toHaveBeenLastCalledWith(models('a'), undefined)
  expect(loads).toHaveLength(2)
  loads[1]!.settle.resolve(models('c'))
  await second
  expect(cache.current()).toEqual(models('c'))

  // A key change rescopes as well, and a missing credential discards without loading.
  state.request = { ...state.request, apiKey: 'other' }
  const third = cache.access()
  await flush()
  expect(loads).toHaveLength(3)
  loads[2]!.settle.resolve(models('d'))
  await third
  state.request = undefined
  await cache.access()
  expect(cache.current()).toBeUndefined()
  expect(loads).toHaveLength(3)
})

it('ignores a load that settles after its scope was replaced', async () => {
  const { cache, loads, state, flush } = harness()
  const stale = cache.access()
  await flush()
  state.request = { ...state.request!, baseURL: 'https://other.test/v1' }
  const fresh = cache.access()
  await flush()
  expect(loads[0]!.signal.aborted).toBe(true)
  loads[1]!.settle.resolve(models('new'))
  await Promise.all([stale, fresh])
  expect(cache.current()).toEqual(models('new'))
})

it('refreshes periodically with the latest settings and stops at dispose', async () => {
  vi.useFakeTimers()
  const { cache, loads, settings } = harness(60_000, 100, true)
  const first = cache.access()
  await vi.advanceTimersByTimeAsync(0)
  loads[0]!.settle.resolve(models('a'))
  await first
  expect(vi.getTimerCount()).toBe(1)

  await vi.advanceTimersByTimeAsync(100)
  expect(loads).toHaveLength(2)
  loads[1]!.settle.resolve(models('a', 'b'))
  await vi.advanceTimersByTimeAsync(0)
  expect(cache.current()).toEqual(models('a', 'b'))

  // The timer already armed fires on the old interval, finds the listing
  // younger than the new max age, and re-arms for the remainder.
  settings.maxAgeMs = 500
  await vi.advanceTimersByTimeAsync(100)
  expect(loads).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(399)
  expect(loads).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(loads).toHaveLength(3)

  const disposal = cache.dispose()
  await vi.advanceTimersByTimeAsync(0)
  await disposal
  expect(loads[2]!.signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  await cache.access()
  expect(loads).toHaveLength(3)
})

it('reports a failed request preparation and keeps serving', async () => {
  const { cache, warn, state } = harness()
  state.fail = new Error('settings broke')
  await cache.access()
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('request preparation failed (Error: settings broke)'))
})

it('scopes a request that carries neither headers nor a key', async () => {
  const { cache, loads, state, flush } = harness()
  state.request = { api: 'openai-completions', baseURL: 'https://gw.test/v1' }
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a'))
  await first
  await cache.access()
  expect(loads).toHaveLength(1)
})

it('stops quietly when disposed while the request is still being prepared', async () => {
  const warn = vi.fn()
  const load = vi.fn()
  const gate = Promise.withResolvers<undefined>()
  const slow = new RouteListingCache({
    settings: () => ({ timeoutMs: 1000, maxAgeMs: 100 }),
    request: async () => {
      await gate.promise
      return { api: 'openai-completions', baseURL: 'https://gw.test/v1' }
    },
    load,
    now: () => 0,
    info: vi.fn(),
    warn,
    changed: vi.fn(),
  })
  const access = slow.access()
  const disposal = slow.dispose()
  gate.resolve(undefined)
  await Promise.all([access, disposal])
  expect(load).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

it('stays quiet when disposed while request preparation fails', async () => {
  const warn = vi.fn()
  const gate = Promise.withResolvers<undefined>()
  const failing = new RouteListingCache({
    settings: () => ({ timeoutMs: 1000, maxAgeMs: 100 }),
    request: async () => { await gate.promise; throw new Error('late failure') },
    load: () => { throw new Error('must not load') },
    now: () => 0,
    info: vi.fn(),
    warn,
    changed: vi.fn(),
  })
  const access = failing.access()
  const disposal = failing.dispose()
  gate.reject(new Error('ignored'))
  await Promise.all([access, disposal])
  expect(warn).not.toHaveBeenCalled()
})

it('drops a successful load that a rescope superseded', async () => {
  const { cache, loads, state, changed, flush } = harness()
  state.honorAbort = false
  const stale = cache.access()
  await flush()
  state.request = { ...state.request!, baseURL: 'https://other.test/v1' }
  const fresh = cache.access()
  await flush()
  // The aborted first load still reports success: the result belongs to a dead scope.
  loads[0]!.settle.resolve(models('stale'))
  loads[1]!.settle.resolve(models('fresh'))
  await Promise.all([stale, fresh])
  expect(cache.current()).toEqual(models('fresh'))
  expect(changed).toHaveBeenCalledTimes(1)
})

it('reports a failure to read the settings while re-arming a refresh', async () => {
  vi.useFakeTimers()
  const { cache, loads, warn, state } = harness(60_000, 100, true)
  const first = cache.access()
  await vi.advanceTimersByTimeAsync(0)
  loads[0]!.settle.resolve(models('a'))
  await first
  // The armed timer fires, finds the listing fresh enough to skip a load, then cannot re-arm.
  state.fail = undefined
  await vi.advanceTimersByTimeAsync(50)
  state.fail = new Error('settings gone')
  await vi.advanceTimersByTimeAsync(50)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('request preparation failed (Error: settings gone)'))
})

it('does not re-arm a refresh once disposed during its access', async () => {
  vi.useFakeTimers()
  const { cache, loads } = harness(60_000, 100, true)
  const first = cache.access()
  await vi.advanceTimersByTimeAsync(0)
  loads[0]!.settle.resolve(models('a'))
  await first
  await vi.advanceTimersByTimeAsync(99)
  const disposal = cache.dispose()
  await vi.advanceTimersByTimeAsync(10)
  await disposal
  expect(vi.getTimerCount()).toBe(0)
})

it('reports a failed change observer and keeps the committed listing', async () => {
  const { cache, loads, changed, warn, flush } = harness()
  changed.mockImplementation(() => { throw new Error('observer failed') })
  const first = cache.access()
  await flush()
  loads[0]!.settle.resolve(models('a'))
  await first
  expect(cache.current()).toEqual(models('a'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('change notification failed'))
})

it('does not warn about work that finishes after dispose', async () => {
  const { cache, loads, warn, flush } = harness()
  const first = cache.access()
  await flush()
  const disposal = cache.dispose()
  await Promise.all([first, disposal])
  expect(loads[0]!.signal.aborted).toBe(true)
  expect(warn).not.toHaveBeenCalled()
})
