/** Credential-scoped `/models` cache with single-flight loads, background refresh, and last-known-good retention. */
import { createHash } from 'node:crypto'
import { ListingCache } from '@deepseek-ai/dsh-llm'
import type { ListingSettings } from './listing-config.ts'
import { LISTING_TIMEOUT } from './listing.ts'
import type { ModelListing } from './listing.ts'

/** Host-owned inputs of one cache instance. */
export interface ListingCacheDependencies {
  /** Latest route configuration for automatic refresh; `undefined` stops following the listing. */
  readonly settings: () => ListingSettings | undefined
  /** The credential the route sends to `url`, or `undefined` when it has none. */
  readonly credential: (url: string) => Promise<string | undefined>
  /** Perform one listing request authenticated with `credential`; `signal` carries the {@link LISTING_TIMEOUT} request deadline. */
  readonly load: (url: string, credential: string, signal: AbortSignal) => Promise<ModelListing>
  /** Wall clock used for listing age. */
  readonly now: () => number
  /** Report a loaded listing. */
  readonly info: (message: string) => void
  /** Report the first failure of a failing streak. */
  readonly warn: (message: string) => void
  /** Publish a changed view; readers can immediately read `current()`. */
  readonly changed: () => void
}

/** What request resolution reads. */
export interface ListingView {
  /** Whether a credential is available for the listing endpoint. */
  readonly authenticated: boolean
  /** Last successful listing for this scope; `undefined` until one succeeds. */
  readonly listing: ModelListing | undefined
}

/** The endpoint and credential one load sends. */
interface ListingRequest {
  readonly url: string
  readonly credential: string
}

/** One route's listing cache; each endpoint and credential pair has its own scope. */
export class ModelListingCache extends ListingCache<ListingRequest, ModelListing> {
  /** @param dependencies - credential, transport, clock, and diagnostic callbacks. */
  constructor(private readonly dependencies: ListingCacheDependencies) {
    super({
      load: ({ url, credential }, signal) => dependencies.load(url, credential, signal),
      timeoutCode: LISTING_TIMEOUT,
      now: dependencies.now,
      info: dependencies.info,
      warn: dependencies.warn,
      where: ({ url }) => url,
      loaded: (listing, url) => `model listing from ${url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`,
      failed: (url, error, retained) => `model listing from ${url} failed (${String(error)}); ${
        retained ? 'keeping the previous catalog' : 'using the bundled catalog'}`,
      changed: () => { dependencies.changed() },
    })
  }

  /**
   * The last published view, without I/O.
   * @returns the credential state and listing of the current scope.
   */
  current(): ListingView {
    return { authenticated: this.scope !== undefined, listing: this.listing }
  }

  /**
   * Resolve the view for the current credential. The first access of a scope
   * waits for its load, which the request deadline bounds; later accesses
   * return at once and refresh a stale listing in the background. After a load settles,
   * automatic refresh uses the latest route settings; failures retain the last successful listing, including badges.
   * @param settings - endpoint and timing of the caller's configuration generation.
   * @param signal - abandons this wait only; the shared load continues.
   * @returns the view after any first load of the scope settles.
   */
  async view(settings: ListingSettings, signal?: AbortSignal): Promise<ListingView> {
    const credential = await this.dependencies.credential(settings.url)
    signal?.throwIfAborted()
    if (this.isClosed()) return this.current()
    const scope = credential === undefined ? undefined : `${settings.url}\n${createHash('sha256').update(credential).digest('hex')}`
    if (scope !== this.scope) this.rescope(scope)
    if (credential !== undefined) {
      await this.ensure({ url: settings.url, credential }, settings, () => this.refresh(settings), signal)
    }
    return this.current()
  }

  /** Discard the listing and abort any in-flight load; the next access loads again and waits like a first access. */
  invalidate(): void {
    this.rescope(this.scope)
  }

  private async refresh(previous: ListingSettings): Promise<void> {
    let settings = previous
    try {
      const next = this.dependencies.settings()
      if (next === undefined) {
        this.invalidate()
        this.notify(undefined, undefined)
        return
      }
      settings = next
      const wasAuthenticated = this.current().authenticated
      await this.view(settings)
      if (this.isClosed()) return
      if (wasAuthenticated && !this.current().authenticated) this.notify(undefined, undefined)
    } catch (error) {
      if (this.isClosed()) return
      this.fail(`model listing refresh failed (${String(error)}); keeping the previous catalog; check listing configuration and credentials`)
    }
    if (!this.loading()) this.schedule(settings, () => this.refresh(settings))
  }
}
