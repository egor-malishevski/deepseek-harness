/**
 * Shared mechanics of provider `/models` listing caches: single-flight loads, a bounded first wait,
 * background refresh, and last-known-good retention. Provider packages subclass it to define what
 * identifies a scope, how a request is resolved, and what a change publishes.
 *
 * @module @deepseek-ai/dsh-llm/listing-cache
 */
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

/** Cache timing of one configuration generation. */
export interface ListingTiming {
  /** Deadline of one listing request, which also bounds a first-use wait. */
  readonly timeoutMs: number
  /** Listing age after which an access refreshes it; zero refreshes on each access and runs no timer. */
  readonly maxAgeMs: number
}

/** Provider-owned inputs of a {@link ListingCache}. */
export interface ListingSource<Request, Listing> {
  /** Perform one listing request; `signal` carries the request deadline. */
  readonly load: (request: Request, signal: AbortSignal) => Promise<Listing>
  /** Timeout code stamped on the request deadline. */
  readonly timeoutCode: string
  /** Wall clock used for listing age. */
  readonly now: () => number
  /** Report a loaded listing. */
  readonly info: (message: string) => void
  /** Report the first failure of a failing streak. */
  readonly warn: (message: string) => void
  /** Endpoint text of `request` for diagnostics. */
  readonly where: (request: Request) => string
  /** The report for a loaded `listing`. */
  readonly loaded: (listing: Listing, where: string) => string
  /** The warning for a failed load; `retained` is whether a listing is still held. */
  readonly failed: (where: string, error: unknown, retained: boolean) => string
  /** The warning for a loaded listing that must not replace the held one, or `undefined` when it is usable. */
  readonly unusable?: (listing: Listing, where: string) => string | undefined
  /** Publish a committed change; `next` is `undefined` when a scope change discarded the listing. */
  readonly changed: (previous: Listing | undefined, next: Listing | undefined) => void
}

/** Wait for `task` unless `signal` aborts first; the task keeps running. */
async function abandonable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return task
  const abandoned = Promise.withResolvers<never>()
  const abandon = (): void => { abandoned.reject(signal.reason) }
  signal.addEventListener('abort', abandon, { once: true })
  try {
    await Promise.race([task, abandoned.promise])
  } finally {
    signal.removeEventListener('abort', abandon)
  }
}

/** One route's listing cache; each scope the subclass names has its own listing. */
export abstract class ListingCache<Request, Listing> {
  /** Identity of the endpoint and credentials the held listing was read with; `undefined` while none can be read. */
  protected scope: string | undefined
  /** The last successful listing of this scope. */
  protected listing: Listing | undefined
  /** Settle time of the latest load in this scope; `undefined` before the first one settles. */
  protected settledAt: number | undefined
  private inflight: Promise<void> | undefined
  private abort: AbortController | undefined
  private generation = 0
  private failing = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Set<Promise<void>>()

  /** @param source - transport, clock, and diagnostic callbacks. */
  constructor(private readonly source: ListingSource<Request, Listing>) {}

  /** Whether {@link dispose} ran; read through a method because it may change across an `await`. */
  protected isClosed(): boolean {
    return this.closed
  }

  /**
   * Stop automatic refresh and abort loads; later results and accesses change nothing.
   * @returns completion of all admitted loads and automatic accesses.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.generation += 1
    clearTimeout(this.timer)
    this.abort?.abort()
    await Promise.allSettled(this.pending)
  }

  /**
   * Move to `scope`, discarding the held listing and aborting any in-flight load.
   * @param scope - the new scope identity.
   * @returns the discarded listing, for a subclass that publishes the discard.
   */
  protected rescope(scope: string | undefined): Listing | undefined {
    clearTimeout(this.timer)
    this.abort?.abort()
    const previous = this.listing
    this.scope = scope
    this.listing = undefined
    this.settledAt = undefined
    this.inflight = undefined
    this.failing = false
    this.generation += 1
    return previous
  }

  /**
   * Record a failure: warn once per failing streak and count the attempt as settled.
   * @param message - the warning for the first failure of a streak.
   */
  protected fail(message: string): void {
    if (!this.failing) this.source.warn(message)
    this.failing = true
    this.settledAt = this.source.now()
  }

  /**
   * Publish a committed change; an observer failure is reported and never rejects.
   * @param previous - the listing before the change.
   * @param next - the listing after the change.
   */
  protected notify(previous: Listing | undefined, next: Listing | undefined): void {
    try { this.source.changed(previous, next) }
    catch (error) { this.source.warn(`model listing change notification failed (${String(error)}); reload the model catalog`) }
  }

  /**
   * Bring the listing of the current scope up to date: the first access waits for the load,
   * later ones return at once and refresh a stale listing in the background.
   * @param request - the request to load with.
   * @param timing - timing of the caller's configuration generation.
   * @param refresh - runs at each automatic refresh.
   * @param signal - abandons this wait only; the shared load continues.
   */
  protected async ensure(
    request: Request,
    timing: ListingTiming,
    refresh: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.settledAt === undefined) await abandonable(this.start(request, timing, refresh), signal)
    else if (this.source.now() - this.settledAt >= timing.maxAgeMs) void this.start(request, timing, refresh)
  }

  /**
   * Arm the next automatic refresh; zero `maxAgeMs` and a disposed cache arm nothing.
   * @param timing - timing of the caller's configuration generation.
   * @param refresh - runs when the timer fires.
   */
  protected schedule(timing: ListingTiming, refresh: () => Promise<void>): void {
    clearTimeout(this.timer)
    if (this.closed || timing.maxAgeMs === 0) return
    const age = this.settledAt === undefined ? 0 : this.source.now() - this.settledAt
    this.timer = setTimeout(() => {
      const operation = refresh().finally(() => {
        this.pending.delete(operation)
      })
      this.pending.add(operation)
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, timing.maxAgeMs - age)))
    this.timer.unref()
  }

  /** Whether a load is in flight; a refresh then leaves the next arming to its completion. */
  protected loading(): boolean {
    return this.inflight !== undefined
  }

  private start(request: Request, timing: ListingTiming, refresh: () => Promise<void>): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    clearTimeout(this.timer)
    this.generation += 1
    const generation = this.generation
    const controller = new AbortController()
    this.abort = controller
    const limit = deadline(controller.signal, timing.timeoutMs, this.source.timeoutCode)
    const where = this.source.where(request)
    const run = this.source.load(request, limit.signal)
      .then((listing) => {
        if (generation !== this.generation) return
        const unusable = this.source.unusable?.(listing, where)
        if (unusable !== undefined) {
          this.fail(unusable)
          return
        }
        const previous = this.listing
        const changed = !deepEqualJson(previous, listing)
        this.listing = listing
        this.settledAt = this.source.now()
        this.failing = false
        this.source.info(this.source.loaded(listing, where))
        if (changed) this.notify(previous, listing)
      }, (error: unknown) => {
        if (generation !== this.generation) return
        this.fail(this.source.failed(where, error, this.listing !== undefined))
      })
      .finally(() => {
        limit[Symbol.dispose]()
        this.pending.delete(run)
        if (this.inflight === run) this.inflight = undefined
        if (generation === this.generation) this.schedule(timing, refresh)
      })
    this.inflight = run
    this.pending.add(run)
    return run
  }
}
