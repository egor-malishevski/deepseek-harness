# Agent Note: Route model discovery

Status: implemented

English | [中文](2026-11-04-route-model-discovery.zh.md)

## Problem

An OpenAI-compatible gateway such as CLIProxyAPI serves a model list that follows its live credentials: models appear and disappear while the harness runs. An `llm-pi-ai` route could only serve the hardcoded `models` array, so selectors offered models the gateway no longer served and omitted new ones until someone edited `cordis.patch.yml`. Existing routes must keep behaving exactly as before.

## Decision

A route opts in with `discoverModels: true`, with `modelsTimeoutMs` (default 5,000) and `modelsMaxAgeMs` (default 600,000, `0` refreshing on each access with no timer), the names and bounds `dsh-llm-deepseek` uses. With the opt-in, `GET {baseURL}/models` decides which models are offered, in listing order. The `models` entries become metadata seed matched by id: seed fields win, and the listing's name, context window, and output cap fill only what the seed leaves unset. A listed id without a seed entry takes the route defaults and does not reason. A seed entry the listing omits stays resolvable but is not offered, so roles and in-flight sessions naming it do not fail with `UNKNOWN_MODEL`; the existing send gate refuses new selections of unlisted models.

Each discovering route owns one in-memory `RouteListingCache` (`listing.ts`), created and disposed by the plugin's `apply` closure as routes toggle the option. It mirrors `dsh-llm-deepseek`'s `ModelListingCache`: single-flight loads, a first wait bounded by `modelsTimeoutMs`, background refresh at `modelsMaxAgeMs`, last-good retention on failure or an empty reply, one warning per failing streak, and a scope key of endpoint, protocol, and a hash of headers plus key that discards the listing when it changes. The cache is a local copy because the deepseek cache loads only with a string credential while a gateway route may authenticate through route headers alone, and `llm-pi-ai` must not depend on `llm-deepseek`.

The profiles memo is keyed by the raw configuration identity and a listings version that increases only when a listing actually changes, so the adapter's snapshot rebuilds then. Operations that captured a snapshot keep it. A change emits `llm/models-updated` for the route, which the GUI already reloads on, and logs a warning for each id that disappeared. `listModels` awaits the route's listing before reading, and `resolveModel` and `prepareCall` await it once and retry when a discovering route has no listing yet and the model is unknown.

The request code is `fetchModelListing` in `discovery.ts`, shared with draft discovery. It sends the route's headers and key and adds `anthropic-version` only on `anthropic-messages`: CLIProxyAPI answers a different reply shape and renames ids when it sees that header or a `claude-cli` user agent.

A listed model that cannot be materialized is skipped and reported through `listingProblems`. It never enters `modelErrors`, because the first model error becomes the route's catalog error and endpoint data must not mark a configuration broken.

## Alternatives considered

**Reuse `ModelListingCache` from `dsh-llm-deepseek`.** Rejected: it would add a dependency from this package to the DeepSeek provider, and it loads only with a string credential.

**Call `discoverModels` from the cache.** Rejected: it answers catalog routes from the installed catalog without a request, and it takes a draft's key rather than the route's headers.

**Persist the listing on disk.** Rejected: a stale file would offer models the gateway no longer serves, and the list is cheap to fetch. An offline start serves the seed instead.

**Treat `models` as the allowlist and the listing as a filter.** Rejected: the goal is new models appearing without edits.

**Put listed-model failures into `modelErrors`.** Rejected: one malformed endpoint row would mark the whole route broken.

## Consequences

A gateway's model changes reach selectors within `modelsMaxAgeMs` without editing configuration. The first listing of a discovering route delays its first `listModels` by up to `modelsTimeoutMs`. The listing carries ids only, so an unseeded model takes route defaults: no reasoning, text input. Seed entries match by exact id with no pattern overrides, and nothing is stored on disk. The listing copy duplicates the deepseek cache's semantics; a change to one should be reviewed against the other.
