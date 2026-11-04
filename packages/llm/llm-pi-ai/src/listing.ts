/**
 * In-memory `/models` listing of one discovering route: single-flight loads,
 * a bounded first wait, background refresh, and last-known-good retention,
 * on the cache mechanics `dsh-llm` shares with `dsh-llm-deepseek`. This class
 * owns what is route-specific: a request that may authenticate through its
 * configured headers alone, a scope that covers those headers, and an empty
 * answer that keeps the previous listing. Nothing is written to disk.
 *
 * @module dsh-llm-pi-ai/listing
 */
import { createHash } from 'node:crypto'
import { ListingCache } from '@deepseek-ai/dsh-llm'
import type { ListingTiming, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type { ModelListingRequest } from './discovery.ts'

/** Timeout code stamped on a listing request deadline. */
export const LISTING_TIMEOUT = 'LLM_PI_AI_MODEL_LISTING_TIMEOUT'

/** Cache timing of one configuration generation. */
export type ListingSettings = ListingTiming

/** Host-owned inputs of one cache instance. */
export interface ListingCacheDependencies {
  /** Latest timing of the route. */
  readonly settings: () => ListingSettings
  /**
   * The request the route currently sends, or `undefined` when its named
   * credential is missing and no listing can be read. Its endpoint, headers,
   * and key define the cache scope.
   */
  readonly request: () => Promise<ModelListingRequest | undefined>
  /** Perform one listing request; `signal` carries the request deadline. */
  readonly load: (request: ModelListingRequest, signal: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>
  /** Wall clock used for listing age. */
  readonly now: () => number
  /** Report a loaded listing. */
  readonly info: (message: string) => void
  /** Report the first failure of a failing streak. */
  readonly warn: (message: string) => void
  /**
   * Publish a changed listing; readers can immediately read `current()`.
   * `next` is `undefined` when a scope change discarded the listing.
   */
  readonly changed: (previous: readonly LlmDiscoveredModel[] | undefined, next: readonly LlmDiscoveredModel[] | undefined) => void
}

/** Identity of the endpoint and credentials a listing was read with; the secret is hashed. */
function scopeOf(request: ModelListingRequest): string {
  const secrets = JSON.stringify([Object.entries(request.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), request.apiKey ?? null])
  return `${request.baseURL}\n${request.api}\n${createHash('sha256').update(secrets).digest('hex')}`
}

/** One route's listing cache; each endpoint, protocol, and credential set has its own scope. */
export class RouteListingCache extends ListingCache<ModelListingRequest, readonly LlmDiscoveredModel[]> {
  /** @param dependencies - request resolution, transport, clock, and diagnostic callbacks. */
  constructor(private readonly dependencies: ListingCacheDependencies) {
    super({
      load: dependencies.load,
      timeoutCode: LISTING_TIMEOUT,
      now: dependencies.now,
      info: dependencies.info,
      warn: dependencies.warn,
      where: request => `${request.baseURL}/models`,
      loaded: (entries, where) => `model listing from ${where} loaded ${entries.length} model(s)`,
      failed: (where, error, retained) => `model listing from ${where} failed (${String(error)}); `
        + `keeping ${retained ? 'the previous listing' : 'the configured models'}`,
      unusable: (entries, where) => entries.length === 0
        ? `model listing from ${where} was empty; keeping the previous listing`
        : undefined,
      changed: dependencies.changed,
    })
  }

  /**
   * The last published listing, without I/O.
   * @returns the listing of the current scope; `undefined` until one loads.
   */
  current(): readonly LlmDiscoveredModel[] | undefined {
    return this.listing
  }

  /**
   * Bring the listing up to date for the route's current request. The first
   * access of a scope waits for its load, which the request deadline bounds;
   * later accesses return at once and refresh a stale listing in the background.
   * Failures never reject: they keep the last good listing and are reported once per streak.
   * @param signal - abandons this wait only; the shared load continues.
   * @throws the signal's reason when it aborts first.
   */
  async access(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.isClosed()) return
    let request: ModelListingRequest | undefined
    let settings: ListingSettings
    try {
      request = await this.dependencies.request()
      settings = this.dependencies.settings()
    } catch (error) {
      if (this.isClosed()) return
      this.fail(`request preparation failed (${String(error)}); check the route's configuration and credential`)
      return
    }
    signal?.throwIfAborted()
    if (this.isClosed()) return
    const scope = request === undefined ? undefined : scopeOf(request)
    if (scope !== this.scope) {
      const previous = this.rescope(scope)
      if (previous !== undefined) this.notify(previous, undefined)
    }
    if (request === undefined) return
    await this.ensure(request, settings, () => this.refresh(), signal)
  }

  private async refresh(): Promise<void> {
    await this.access()
    if (this.loading() || this.isClosed()) return
    let settings: ListingSettings
    try { settings = this.dependencies.settings() }
    catch (error) {
      this.fail(`refresh could not be scheduled (${String(error)}); the next access retries`)
      return
    }
    this.schedule(settings, () => this.refresh())
  }
}
