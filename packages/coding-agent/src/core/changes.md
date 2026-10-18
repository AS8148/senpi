## 2026-10-18 - Session move phase 1 and related core deltas arrive through the base merge (senpi#3631 lineage)

### What changed

- `agent-session.ts`, `agent-session-runtime.ts`, `agent-session-services.ts`, `sdk.ts`: engine export/import with single-owner ownership (session move phase 1) and the surrounding core deltas landed on main and reach this branch through the pure base merge; this branch adds no change of its own to them beyond the tool-child runtime already tracked elsewhere.

### Why

- The changelog gate reads the merge-base diff, which after the base merge includes main's own changes to these files; this entry records that provenance.

### Why an extension could not handle it

- Core session ownership machinery; not extension surface.

### Expected merge conflict zones

- `changes.md` only.

- HIGH: `agent-session.ts` around `applyCompaction()`, compaction abort controllers, and extension context binding.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions`.

### Migration notes

If upstream adds a native progress or cancellation API for compaction, map the builtin compaction extension to that API while preserving the invariant that visible feedback starts before extension summary generation begins and ends exactly once.

## Seam 4: Unified Compaction Pipeline (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Consolidated manual, threshold, overflow, pre-prompt, and extension-triggered compaction routes into a single private `_executeCompaction()` pipeline.
- The unified pipeline covers: preparation, extension hook execution (`session_before_compact`), summary generation, pre-append token simulation, session append, context rebuild, and completion event emission (`session_compact`).
- Route-specific metadata (reason, custom instructions, thinking/max-token behavior), error handling, retry handling, token estimation before append, and abort handling now flow through one seam.

### Why

- The user identified 9 route inconsistencies caused by duplicated compaction code paths across manual `/compact`, threshold-triggered, overflow-recovery, pre-prompt, and extension-triggered compaction.
- Without unification, each route handled metadata, error recovery, token estimation, and event emission differently, causing observable behavioral differences for extensions consuming compaction events.

### Why extension system couldn't handle this

The duplicated route control flow lives inside `AgentSession`. Extensions can customize compaction content via `session_before_compact` hooks, but they cannot unify internal caller behavior, append semantics, context rebuilds, or core event ordering from outside the session.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` is the highest-churn upstream file. Rebase conflict resolution must preserve the `_executeCompaction()` pipeline and keep branch summarization outside this helper.

### Migration notes

If upstream modifies any compaction route (manual, threshold, overflow, pre-prompt), resolve conflicts by routing the modified logic through `_executeCompaction()` rather than restoring inline duplication. Preserve the 6-route coverage: manual, threshold, overflow-recovery, pre-prompt, extension-triggered, and branch summarization (which routes through the hook but remains a separate caller). Keep the pre-append token simulation step to prevent post-compaction overflow.

## builtin extension labels

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so builtin extensions keep stable synthetic ids like `<builtin:todowrite>` instead of being loaded as numbered inline factories.
- This was changed in core because the startup Extensions list is sourced from extension metadata produced by `DefaultResourceLoader`; the extension API cannot rename builtin factory identities after load.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## move selected defaults to global extensions

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so `diff`, `files`, `prompt-url-widget`, and `tps` are no longer registered as builtin factories.
- `DefaultResourceLoader` now seeds generated shim files for those four defaults into the real global `agentDir/extensions/` directory, so they load through normal global extension discovery instead of builtin registration.
- `DefaultResourceLoader` now rewrites previously generated shim files when their absolute builtin module paths become stale after the checkout/package directory moves or is renamed.
- This had to be done in core because builtin-vs-global extension ownership is determined during resource bootstrap, before any extension code runs.
- Expected merge-conflict zone on upstream sync: builtin extension registration and early resource bootstrap in `src/core/resource-loader.ts`.

## disable builtin extensions from settings

- Changed `src/core/settings-manager.ts` and `src/core/resource-loader.ts` so `settings.json` can disable selected builtin extensions with `disabledBuiltinExtensions`.
- `DefaultResourceLoader` now skips builtin factories whose ids are listed in settings.
- This had to be done in core because builtin extensions are instantiated during early resource bootstrap, before project extensions can intercept or unregister them.
- Expected merge-conflict zone on upstream sync: settings schema/getters in `src/core/settings-manager.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## steering default mode to all

- Changed `src/core/settings-manager.ts` so `getSteeringMode()` now defaults to `"all"` instead of `"one-at-a-time"` when no explicit setting is present.
- Added `test/settings-manager.test.ts` coverage to lock the new default behavior.
- This was changed in core because the default steering mode is injected into `Agent` during session creation via `SettingsManager`, so an extension cannot change the built-in default before the session runtime is constructed.
- Expected merge-conflict zone on upstream sync: `src/core/settings-manager.ts` default getter behavior.

## builtin openai service tier setting

- Changed `src/core/settings-manager.ts`, `src/core/extensions/builtin/index.ts`, and added `src/core/extensions/builtin/service-tier.ts` so `settings.json` can set `openai.serviceTier` and automatically inject `service_tier` into OpenAI Responses payloads.
- Added test coverage in `test/suite/service-tier-extension.test.ts`, `test/suite/service-tier-settings.test.ts`, and updated builtin extension registration coverage in `test/resource-loader.test.ts`.
- This was changed in core because builtin extension registration and settings schema/getter wiring happen before extension code can discover a new builtin id or read typed settings from the existing settings manager.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and settings schema/getter additions in `src/core/settings-manager.ts`.

## synced builtin extensions and webfetch

- Changed `src/core/extensions/builtin/index.ts`, `src/core/resource-loader.ts`, and `src/core/settings-manager.ts` so builtin extensions can be allowlisted with `enabledBuiltinExtensions` while preserving `disabledBuiltinExtensions` as an override.
- Added `src/core/extensions/builtin/webfetch/` as a builtin extension synced from `../pi-extensions/pi-webfetch`, and moved `bash-timeout` and `openai-api-parallel-tool-calls` to synced `../pi-extensions` layouts.
- Added `scripts/sync-builtin-extensions.mjs`, wired into the package build, so local builds refresh the vendored builtin snapshots from `SENPI_BUILTIN_EXTENSIONS_SOURCE` or `../pi-extensions` when that source checkout exists. `external-versions.json` records the source package names and versions included in the snapshot.
- This had to be done in core because builtin extension registration and builtin settings filtering happen before any user extension can affect resource discovery.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts`, builtin factory filtering in `src/core/resource-loader.ts`, and settings schema/getters in `src/core/settings-manager.ts`.

## Anthropic "max" thinking level and provider/model extraBody config

- Widened the `"max"` thinking level through the coding agent surface: CLI `--thinking max`, `/settings` selector, Shift+Tab cycle, `settings.json` `defaultThinkingLevel`, thinking border color mapping.
- Extended `packages/coding-agent/src/core/model-registry.ts` so `models.json` (and `pi.registerProvider()`) accepts `extraBody` at both provider and per-model level. `getApiKeyAndHeaders` now resolves `extraBody`, and `sdk.ts` merges provider/model extraBody with any call-site `extraBody` before invoking `streamSimple`.
- This had to be done in core because `ThinkingLevel` is exported from `@mariozechner/pi-agent-core` and every UI/CLI/settings surface needed to be widened, and because `getApiKeyAndHeaders` + stream option composition live in core `ModelRegistry`/`sdk.ts`.
- Expected merge-conflict zone on upstream sync: `model-registry.ts` schemas + `getApiKeyAndHeaders`, `sdk.ts` stream option composition, `cli/args.ts` validator, `settings-manager.ts` thinking level type, `agent-session.ts` thinking cycle list, interactive TUI thinking selector and border color map.

## RPC prompt-level thinking and fallback level events (2026-07-22)

### What changed

- `agent-session.ts`: accepts a session-only `PromptOptions.thinkingLevel`, rejects queued prompts carrying it before queue mutation, and emits `thinking_level_changed` when retry fallback applies an ephemeral level.

### Why extension system couldn't handle this

- Prompt preflight, session-only level application, fallback model switching, and session event emission are private core lifecycle boundaries.

### Expected merge conflict zones

- HIGH: `agent-session.ts` prompt serialization and fallback model-switch logic.

## Extension event bus follows the loaded generation into runtime (2026-08-11)

`LoadExtensionsResult` now retains the event bus used to construct extension APIs, and
`AgentSession` passes that exact bus into `ExtensionRunner`. RPC subscriptions must bind to this
generation-owned bus rather than an unrelated runtime or resource-loader instance, especially after
extension reloads. Test extension results preserve the same ownership contract.
## Preserve extension event bus after project trust resolution (2026-08-11)

The trusted/untrusted extension result composition now carries forward the shared event bus used by
both pre-trust and remaining extensions. Dropping it caused `ExtensionRunner` to allocate an
unrelated fallback bus, silently disconnecting `pi.rpc.emit` on trust-requiring projects.

## 2026-08-25 - reject upstream Radius session sharing artifacts

### What changed

- `packages/coding-agent/src/core/radius.ts`: intentionally absent from Senpi; upstream Radius sharing is rejected under the fork sharing policy.

### Why

- Senpi retains its gist-based `/share` flow and `pi.dev` viewer instead of adopting the upstream Radius service.

### Why an extension could not handle it

- Sharing implementation ownership is a core product policy decision, not an extension-level adaptation.

### Expected merge conflict zones

- NONE: the upstream-only Radius artifact remains excluded from the fork tree.

## 2026-08-25 - Preserve upstream session event behavior

### What changed

- `packages/coding-agent/src/core/agent-session.ts` retains fork queue and compaction behavior while adopting upstream custom-message ordering.

### Why

- Session event ordering is a provider and persistence runtime contract.

### Why this lives in the fork

- Agent session orchestration executes below extension interception.

### Expected merge conflict zones

- Agent event dispatch and custom-message queue handling.

## 2026-09-03 - Reconcile upstream agent-session admission and runtime replacement

### What changed and why

- Kept senpi compaction admission, abort, model persistence, and event-union behavior while removing the obsolete queued-message gate and callback re-sample from next-turn refresh; runtime replacement now settles the outgoing session before creating the fork target and preserves extension spill reporting.

### Why

- Upstream loop ordering already drains continuation messages into loop-local state before preparation, so the old gate skipped required threshold compaction. Settling before fork creation preserves outgoing JSONL and active-turn lifecycle ordering.

### Why an extension could not handle this

- Session admission, persistence, abort, and runtime replacement are core lifecycle boundaries below extension interception.

### Expected merge conflict zones

- `src/core/agent-session.ts` next-turn refresh and compaction lifecycle; `src/core/agent-session-runtime.ts` replacement ordering.

## 2026-09-06 - Optional compaction model override for Claude SDK OAuth

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: resolves an optional `compaction.model` provider/model override for default compaction summarization, while preserving session-model lifecycle bookkeeping and falling back to the session model for malformed or unknown overrides.

### Why

- Claude SDK OAuth lanes can retain a resident SDK session whose native compaction does not fire; users need a reliable senpi-owned summarization escape hatch on a separate model.

### Why an extension could not handle it

- Model resolution, summarization authentication, and the core compaction execution request are session lifecycle boundaries below extension interception.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` around `_resolveCompactionModel()` and `_executeCompaction()` default summarization request construction.

## 2026-09-06 - Thread compaction model overrides through settings

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: preserves the optional `compaction.model` provider/model value in the resolved compaction settings returned to core and extensions.

### Why

- The compaction executor and lane policy need one resolved settings path so the override is applied consistently without changing unrelated session settings.

### Why an extension could not handle it

- Settings resolution is owned by the core settings manager and occurs before extension contexts consume the resolved compaction settings.

### Expected merge conflict zones

- `packages/coding-agent/src/core/settings-manager.ts` `Settings.compaction` typing and `getCompactionSettings()` return value.
## 2026-09-06 - Fail closed when recovery fallback cannot admit context

### What changed

- packages/coding-agent/src/core/agent-session.ts now preserves the active
  session model and ends retry recovery deterministically when a fallback
  candidate fails the live context usability admission check.

### Why

- Authentication and compaction failures could otherwise advance through
  unrelated fallback providers after a candidate was already proven unable to
  hold the live session context.

### Why this lives in the fork

- Retry ownership and fallback switching are core `AgentSession` behavior below
  the extension API.

### Expected merge conflict zones

- LOW: `_handleRetryableError` fallback admission in
  packages/coding-agent/src/core/agent-session.ts.
## 2026-09-06 - Make fallback activation atomic for unusable candidates

### What changed

- packages/coding-agent/src/core/agent-session.ts performs model-select hooks
  and usability admission before persisting or emitting a model change.
- packages/coding-agent/src/core/retry-fallback/controller.ts reserves fallback
  candidates only after a successful model switch.

### Why

- An over-budget fallback could mutate session state and announce a rejected
  model before admission failed, causing false model-change/retry events and
  leaking the typed usability error.

### Why this lives in the fork

- Retry ownership, model admission, and fallback switching are core session
  behavior below the extension API.

### Expected merge conflict zones

- LOW: fallback switch admission in
  packages/coding-agent/src/core/agent-session.ts and candidate reservation in
  packages/coding-agent/src/core/retry-fallback/controller.ts.



## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/coding-agent/src/core/agent-session-runtime.ts`: fork `AgentSessionLaunchProfile` (immutable cwd/permission/creation-model/thinking flags), settle-before-replacement and `session_extensions_removed` reporting, plus upstream's import path: `reserveSessionWrite(destinationPath)` followed by `copyFileSync(..., COPYFILE_EXCL)` when the source is not already stored.
- `packages/coding-agent/src/core/agent-session.ts`: fork structure throughout (admission accounting, `compactBeforeNextAdmission` instead of upstream's `_compactBeforeNextAssistantResponse`, `preflightToolCall`/`_emitAfterToolCallHooks`, constants and tool-result truncation, input ids `${sessionId}:${n}` with `emitInputDisposition`/`throwIfCancelled`, `expandPromptTemplateWithMetadata` + `command_invocation`) with upstream behavior ported in: `_getCompactionSettings(forModel)` at every compaction read (D-L), retry delay `min(planner delay, settings.maxAgentDelayMs)` (D-M), and `steer`/`followUp` running input handlers through `_queueUserInput(text, images, behavior, { enqueueOrder, source })` (D-N).
- `packages/coding-agent/src/core/keybindings.ts`: fork bindings `app.history.search` (ctrl+r), `app.tree.editMessage` (ctrl+e), `app.models.toggleFavorite` (ctrl+f) and the Windows/WSL defaults, alongside upstream's `app.thinking.save`; `isRecord`/`hasOwn` helpers for the config parse.
- `packages/coding-agent/src/core/messages.ts`: fork `ConfigurationUpdateMessage`, context-excluded custom messages (`GOAL_CONTINUATION_MESSAGE_TYPE`), provenance copying, `dropFailedAssistantTurns` as the final transform, and the transport image budget (`elideOldImages`, `convertToLlmForTransport`, placeholders); upstream's `fromId: string | null` widening landed.
- `packages/coding-agent/src/core/model-registry.ts`: fork `AuthStorage`-backed registry (`create`/`inMemory`, `modelRuntime` getter, availability snapshot fallback, `getUpstreamModelId`/`getServiceTier`, `extraBody` in compatibility headers) with upstream's `stream()`/`streamSimple()` passthroughs.
- `packages/coding-agent/src/core/model-resolver.ts`: fork defaults (`openai-codex` gpt-5.6-sol, ollama, cursor `auto`), `AvailableModelsSource`, stored-reference resolution, pattern ownership metadata, service-tier and thinking provenance; upstream's `radius: "balanced"` default restored.
- `packages/coding-agent/src/core/model-runtime.ts`: fork runtime (wire identity set at import, credential pool slots and rotation stream, remote catalog provider, `withPayloadRequestMetadata`, `isFallbackEligible`, `hasFreshAvailabilitySnapshot`, `reloadConfig`, native provider registration); upstream's `streamDeferred` split adopted.
- `packages/coding-agent/src/core/session-manager.ts`: `_setSessionFile` keeps the fork reader contract (headerless file -> fresh in-memory id, never a replacement file, resident-store externalize, `mutationCount` bump) and upstream's `_loadEntries` + `inMemory(cwd, options, entries)` ingestion was extended with the same store handling.
- `packages/coding-agent/src/core/settings-manager.ts`: `export type * from "./settings-public-types.ts"` stays (upstream's inline `CompactionSettings`/`RetrySettings` moved into the fork type modules); compaction getters take `forModel?` and keep the fork return type `ResolvedCompactionSettings & { model?: string }`; `getRetrySettings()` returns `maxAgentDelayMs` defaulting to pi-ai's `DEFAULT_MAX_AGENT_RETRY_DELAY_MS` and `maxRetries` from the senpi default retry profile.
- `packages/coding-agent/src/core/skills.ts`: the fork `<skill_roots>` alias table and stronger loading sentence, rendered for both the read and upstream's new bash-only `fileReadTool` branch.

### Why

- The session loop, model runtime and settings model carry the fork's admission/compaction policy, credential pooling, Astra configuration replay and retry profiles; upstream's per-model compaction budgets, retry cap and queued-input handlers were folded into those shapes rather than replacing them.

### Why an extension could not handle it

- These are the core session, registry and settings classes that extensions receive; their constructors, getters and event contracts cannot be swapped from an extension.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/src/core/agent-session.ts` (`prompt`, `steer`/`followUp`, `_queueUserInput`, compaction and retry blocks); `packages/coding-agent/src/core/settings-manager.ts` compaction/retry getters; `packages/coding-agent/src/core/session-manager.ts` loaders.
- MEDIUM: `packages/coding-agent/src/core/model-runtime.ts` stream wrappers; `packages/coding-agent/src/core/model-registry.ts` availability methods; `packages/coding-agent/src/core/messages.ts` `convertToLlm`.
- LOW: `packages/coding-agent/src/core/keybindings.ts` binding table; `packages/coding-agent/src/core/model-resolver.ts` defaults map; `packages/coding-agent/src/core/skills.ts` prompt text; `packages/coding-agent/src/core/agent-session-runtime.ts` import path.

## 2026-09-15 - Resident store blob backing + idle materialized-view release

### What changed

- `packages/coding-agent/src/core/session-resident-store.ts`: eviction now has a recoverable backing. When the resident budget is exceeded, the least-recently-used string is written to a lazily-resolved blob directory (temp file + rename) before being dropped from the map; `materialize` hydrates evicted strings from that directory without re-entering the resident cache, so a bulk read cannot refill the budget. Without a backing directory eviction is disabled entirely — strings stay resident beyond the budget because dropping them would leave consumers holding unreadable sentinel tokens (previously reachable for in-memory sessions over 64 MiB). `clear()` wipes the blob cache along with the map; `stats()` gained `evictedCount`/`evictedBytes`.
- `packages/coding-agent/src/core/session-manager.ts`: persisted sessions configure the store with `<sessionDir>/resident-blobs/<sessionId>` (`--no-session` resolves to no directory and never writes blobs), and a new `dropMaterializedCaches()` releases `entriesCache`, `branchCache`, and `compactEntriesCache`.
- `packages/coding-agent/src/core/agent-session.ts`: `_emitAgentIdleAfterDeferredTurns()` releases the memoized materialized views right before emitting `agent_idle`. Materialized entries hold the full persisted strings, so views kept between turns pinned the entire session text in resident memory while idle (measured: an idle session held ~1.1 GB dirty JS heap on macOS via `footprint`; the store budget alone bounded only its own map while the views re-pinned everything).

### Why

- The store's 64 MiB budget bounded only its own map. `getEntries()` memoizes fully materialized entries, so the last read before idle kept every large tool result alive, and recovery for evicted strings re-parsed the entire session JSONL per missing entry (`loadEntriesFromFile` inside `_materializeEntry`). The blob backing makes recovery O(string) via one small file read while the session file remains authoritative: a missing or corrupt blob falls back to the existing batched JSONL recovery unchanged.

### Why an extension could not handle it

- `entriesCache`/`branchCache`/`compactEntriesCache` are private `SessionManager` state and the `agent_idle` settle boundary is private `AgentSession` orchestration; no extension hook can release these views at the right time, and the recovery path lives inside the store's own materialization.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/session-resident-store.ts` internals; `packages/coding-agent/src/core/session-manager.ts` constructor tail and the block after `getEntries()`; `packages/coding-agent/src/core/agent-session.ts` `_emitAgentIdleAfterDeferredTurns` tail.

## 2026-09-16 - Resident store review fixes (branch-token baking, blob integrity, dir leaks, idle state)

### What changed

- `packages/coding-agent/src/core/session-resident-store.ts`: blobs are JSON envelopes (`{v:1,text}`) and `_readBlob` validates them, so a truncated or mangled blob falls back to JSONL recovery instead of hydrating garbage; `externalizeString` consults an `idsByText` reverse index (deleted on eviction/spill/clear) so re-externalizing the same resident text is idempotent instead of double-counting bytes; new `externalizeInPlace()`/`materializeInPlace()` mutate nested string fields in place (object identity preserved) and `resolvedBlobsDir()` exposes the active backing.
- `packages/coding-agent/src/core/session-manager.ts`: `createBranchedSession()` materializes the branched entries via `_materializeEntries()` BEFORE clearing the store, so re-externalization can no longer bake sentinel tokens into the new branched JSONL; `_resetToNewSession()` and the branch path capture and remove the previous session's blob directory that `clear()` could no longer reach after the session-id switch; new `getResidentStore()` accessor.
- `packages/coding-agent/src/core/agent-session.ts`: the idle settle now also tokenizes `agent.state.messages` in place (the runtime copies that pinned the same large strings the views pinned); `prepareNextTurnWithContext` and `transformContext` re-materialize them, so every provider request and every per-turn consumer reads real strings.
- `test/suite/harness.ts`: `getUserTexts`/`getAssistantTexts` materialize through the store — post-idle runtime state legitimately holds tokens.

### Why

- ChatGPT-web review of PR #1726/#1729 confirmed four defects: branch-time token baking, missing blob corruption detection, old-session blob-directory leaks, and idle retention through agent state. Each fix keeps the session file authoritative: corruption and hydration misses still fall back to the existing batched JSONL recovery.

### Why an extension could not handle it

- All four fixes live inside private store/`SessionManager`/`AgentSession` lifecycles (ordering around `clear()`, the blobsDir provider, and the idle settle boundary); extensions never see these transition points.

### Expected merge conflict zones

- LOW: `core/session-resident-store.ts` (blob envelope + reverse index); `core/session-manager.ts` (`_resetToNewSession`, `createBranchedSession`); `core/agent-session.ts` (idle settle, `transformContext`, `prepareNextTurnWithContext` wrappers).

## 2026-09-15 - Spill resident strings to the blob backing across compaction

### What changed

- `packages/coding-agent/src/core/session-resident-store.ts`: new `spillResident()` writes every resident string to the blob backing and empties the map while keeping the backing itself, unlike `clear()` which wipes both.
- `packages/coding-agent/src/core/session-manager.ts`: `_trimMirrorAfterCompaction()` spills instead of clearing, so strings referenced by the retained mirror (and by branches over pre-compaction history) keep hydrating from the backing after compaction instead of falling back to the batched full-JSONL reload.

### Why

- The previous compaction path cleared the store, which also dropped the blob cache, pushing every post-compaction read of evicted strings back onto `_loadFullHistoryEntries()` (a full session-file parse). With the spill, compact-context recovery stays O(string) per entry across compaction boundaries.

### Why an extension could not handle it

- The mirror-trim path and the store's backing lifecycle are private `SessionManager`/store internals; extensions never see the spill point.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/session-resident-store.ts` (new method after `clear()`); `packages/coding-agent/src/core/session-manager.ts` `_trimMirrorAfterCompaction` one-line change.

## 2026-09-16 - Resident store: content-addressed blobs, token-free runtime reads, bounded blob lifetime

### What changed

- `packages/coding-agent/src/core/session-resident-store.ts`: blob ids are the SHA-256 hex of the text (the token stays `RESIDENT_STRING_PREFIX + id`); the `idsByText` reverse index and the per-instance counter are gone, so `spillResident()` releases every spilled string and re-externalizing hydrated text maps to the existing blob instead of minting a new file. `_writeBlob` skips a file that already exists (same hash, same bytes) while still counting the eviction; `_readBlob` deletes a blob that fails the envelope check so the next eviction rewrites it. `transformJsonValue` throws `TypeError("Do not know how to serialize a BigInt")` again instead of letting a bigint reach the `WeakSet` cycle guard.
- `packages/coding-agent/src/core/agent-session.ts`: the idle settle releases the materialized views and tokenizes `agent.state.messages` only when `residentStore.stats().evictedCount > 0` (the release frees memory only for blob-hydrated strings) and sets a latch; `get messages()`, `prepareNextTurnWithContext`, and the out-of-turn token estimators (`_estimateCompactionLogTokens`, `_blockedAdmissionContentTokens`, `_resolveThresholdContextTokens`, the compaction-threshold estimate, `_shouldCompact`) read through `_runtimeMessages()`, which hydrates the runtime array in place when the latch is set. `dispose()` disposes the session manager.
- `packages/coding-agent/src/core/session-manager.ts`: `dispose()` removes the blob directory and unregisters the session writer; `_setSessionFile` clears a stale `resident-blobs/<sessionId>` directory when a persisted session is opened or recovered.
- `packages/coding-agent/test/suite/harness.ts`: `getUserTexts`/`getAssistantTexts` read plain message text again (the store wrapper was a symptom of the token leak).

### Why

- Review of PRs #1726/#1729 (issue #1746) found: spilled strings pinned by the reverse-index keys; a bigint crashing with `WeakSet values must be objects`; `session.messages` exposing resident tokens between `agent_idle` and the next turn; per-process numeric ids creating a new blob per re-externalize and colliding across processes on one session directory; the idle release re-materializing the full history every turn even when nothing was evicted; and no blob-directory cleanup on writer teardown or session reopen.

### Why an extension could not handle it

- Blob naming, the idle settle boundary, the runtime message accessor, and the session-writer lifecycle are private store/`SessionManager`/`AgentSession` internals; extensions observe none of these transition points.

### Expected merge conflict zones

- LOW: `core/session-resident-store.ts` (id derivation, `_writeBlob`/`_readBlob`); `core/agent-session.ts` (`_emitAgentIdleAfterDeferredTurns`, `get messages`, estimator call sites, `dispose`); `core/session-manager.ts` (`_setSessionFile`, new `dispose`).

### 2026-09-16 addendum - the last owner clears the blob directory

- `packages/coding-agent/src/core/session-write-reservation.ts`: new `hasOtherLiveSessionWriter(path, self)` answers whether another live persisted writer still owns a session file, pruning collected refs like `liveSessionWritePaths()` does.
- `packages/coding-agent/src/core/session-manager.ts`: both blob-directory releases (the stale clear in `_setSessionFile` and `dispose()`) go through `_releaseBlobsDirUnlessShared()`, which keeps the directory while another live manager owns the same session file. The app-server loads a thread that is already open (`modes/app-server/threads/registry.ts` disposes the duplicate `AgentSession`), and without this the duplicate's teardown took the live manager's cache, costing it a full JSONL recovery per evicted string.

## Adopted upstream v1.0.0 core session, runtime and settings (2026-10-02)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/model-runtime.ts`
- `packages/coding-agent/src/core/remote-catalog-provider.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/settings-manager.ts`

Upstream session/runtime/settings changes are kept with fork behaviour preserved: `quietStartup: "header"` (D-6), `/reload` enables tools newly added to defaultTools, and the absorbed main's runtime catalog work.

### Why

Each is an upstream improvement that does not break a fork behaviour; fork alternatives stay in place and are tested.

### Why an extension could not handle it

Session runtime, model runtime, remote catalog and settings own these paths below the extension API.

### Expected merge conflict zones

Upstream edits to core session/settings/runtime paths at the next sync.

## The session launch profile carries the browser engine (2026-10-03)

### What changed

- `packages/coding-agent/src/core/agent-session-runtime.ts`: `AgentSessionLaunchProfile.browserEngine` and `setBrowserEngine`, which also updates the frozen profile so a later switch, new session or fork keeps the engine.
- `packages/coding-agent/src/core/agent-session.ts`, `agent-session-services.ts`, `sdk.ts`: the engine is passed through session creation, held on `AgentSession` (`browserEngine`, `setBrowserEngine`) and handed to extensions through the context action `getBrowserEngine`.
- `core/browser-engine.ts` (new): the `BrowserEngine` values and the `OMO_BROWSER_ENGINE` name.

### Why

`open_session.browserEngine` (senpi#2611) is a per-session choice; the profile is where every other per-session open field (`promptSurface`, `kind`, `context`) already lives.

### Why an extension could not handle it

Session creation and the launch profile are core lifecycle code that runs before extensions load.

### Expected merge conflict zones

The `promptSurface` plumbing in `agent-session.ts`, `agent-session-services.ts` and `sdk.ts`, which the new field sits next to.

## 2026-10-05 - A project codemode file that names an executable asks for project trust

### What changed

- `packages/coding-agent/src/core/trust-manager.ts`: `hasTrustRequiringProjectResources` also returns `true` when `<cwd>/.senpi/codemode.json` sets any setting on the codemode package's list of executable-naming settings (`@code-yeongyu/senpi-codemode/executable-settings.json`, today `languages.pyInterpreter`), found through the bundled-extension resolver. A codemode file that sets none of them stays trust-free. A file that is not valid JSON asks, as a project `mcp.json` does by its presence alone; so does any codemode file when the list cannot be read.

### Why

- An executable-naming setting is run by the codemode extension at session start (its `--version` probe, then the kernel). Codemode honours a project-scoped value only when the project is trusted, but a project whose only config was `.senpi/codemode.json` counted as having no trust-requiring resources, so it was treated as trusted without asking and a cloned repository could run a binary of its choosing. Keeping the list in the codemode package means a new executable setting there is covered here without a core change.

### Why an extension could not handle it

- The launch-time trust decision is made in the host before any extension is bound; an extension can only read the decision through `isProjectTrusted()`, which reported "trusted" for a project the host never asked about.

### Expected merge conflict zones

- LOW: the `projectCodemodeNamesExecutable` helpers after `LEGACY_PROJECT_CONFIG_DIR_NAME`, the `bundled-resources.ts` import, and the one-line call after the config-dir check at the top of `hasTrustRequiringProjectResources` in `packages/coding-agent/src/core/trust-manager.ts`.

## 2026-10-08 - A tool's answer words reach the model as a user turn after its tool results (senpi#2920)

### What changed

- `packages/coding-agent/src/core/messages.ts`: `convertToLlm` ends by passing its output through `appendToolResultUserWords` (`core/tool-result-user-words.ts`): after each contiguous run of tool results, one user message holds, for every result whose `details.userWords` lists `{ label, text }` words, a `[label]` text block followed by the word as its own text block. It is skipped when the next message already starts with those blocks (converting twice adds it once), and it carries its own copy of the last word-carrying result's request-local context provenance (sealed with its own fingerprint only while that result still matches its seal), so OpenAI remote-compaction replay treats it as part of the same checkpoint.
- `packages/coding-agent/src/core/agent-session.ts`: `sendUserMessage` with a content array of more than one text part passes the parts to `prompt()` as the internal `PromptOptions.textBlocks`. The started prompt (`userContent`) and a queued steer or follow-up (`_enqueuePreparedInput`) build the user message's text through `userTextContent` (`core/user-text-blocks.ts`), which keeps the parts as separate text blocks while they still spell the final text joined by a newline, and falls back to one block when a template expansion rewrote it. An `input` handler's rewrite is not applied to a built-in later ask-user answer (`keepsTextBlocksVerbatim`). `getUserMessagesForForking` shows such an answer with its words in place (`askUserAnswerDisplayText`).

### Why

- Anthropic's Claude Haiku 5.5 guide ("Mid-turn user messages") says user text inside a `tool_result` may be treated as untrusted, and that a harness notice and the user's words must not share a block. The ask-user builtin keeps a blocking answer's words in the persisted tool result instead of the tool content; building the user message from that result on every request means no queue operation (Esc, `clear_queue`, an abort, a session release) can drop or delay them, and live requests, resumed sessions and compaction all see the same messages. A later answer arrives as a frame block plus labelled word blocks, which the joined-text paths used to merge.

### Why an extension could not handle it

- The message-to-LLM conversion and the prompt/queue paths that build the user message are the host's own; an extension can only hand content to `pi.sendUserMessage` or return a tool result.

### Expected merge conflict zones

- LOW: the final `return` of `convertToLlm` and its import in `messages.ts`; in `agent-session.ts`, `PromptOptions` (new `textBlocks`), the `inputResult.action === "transform"` branch and the `userContent` line in `prompt()`, the `_queueSteer` / `_queueFollowUp` / `_enqueuePreparedInput` signatures and content line, the text-part loop plus `prompt()` call in `sendUserMessage`, and the `text` line of `getUserMessagesForForking`.

## 2026-10-08 - Recognize GPT-6.1 Sol as a documented Ultrafast model (senpi#2975)

### What changed

- `packages/coding-agent/src/core/ultrafast-lanes.ts`: the documented model set includes `gpt-6-astra` and `gpt-6.1-sol`, so the native Sol Ultrafast alias does not emit an unsupported-tier warning after the service-tier extension resolves its upstream id. Other models and non-first-party providers retain their warnings.

### Why

- The current subscription catalog advertises Ultrafast for both models; the previous Astra-only notice was misleading for Sol.

### Why an extension could not handle it

- Model resolution and the builtin service-tier extension share this core warning policy.

### Expected merge conflict zones

- LOW: the documented model set and warning text in `packages/coding-agent/src/core/ultrafast-lanes.ts`.
## 2026-10-10 - Replay-safe retained recovery and durable rejection admission (senpi#3060)

### What changed

- `packages/coding-agent/src/core/session-manager.ts`: a deterministic checkpoint's `retainedMessagePolicy` applies JSON-normalized safe replacements to retained model context, carrying entry provenance onto copies. The policy survives later checkpoints and reopen, without rewriting source entries or applying to messages after the recovery boundary.
- `packages/coding-agent/src/core/agent-session.ts`: pre-prompt and automatic compaction consult the persisted identical-recovery rejection latch before emitting an attempt. Manual compaction remains an explicit retry.

### Why

An unsafe newest result poisoned every retained suffix. Repeated automatic admission retried an unchanged impossible recovery, including after session reopen.

### Why an extension could not handle it

`packages/coding-agent/src/core/session-manager.ts` owns canonical replay, resume, and compaction admission projections. `packages/coding-agent/src/core/agent-session.ts` emits automatic attempt events before extension hooks run; both must honor the same durable policy.

### Expected merge conflict zones

- `packages/coding-agent/src/core/session-manager.ts`: `projectSession` provenance mapping.
- `packages/coding-agent/src/core/agent-session.ts`: `_runPrePromptCompaction` and `_runAutoCompaction` admission.

## 2026-10-10 - Share actual compaction admission with terminal rejection classification (senpi#3061)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `_wouldCompactionOverflow` delegates the existing projection, Cursor history admission and effective-reserve calculation to `wouldCompactionOverflow` in the compaction builtin's rejection helper.

### Why

- `packages/coding-agent/src/core/agent-session.ts`: a generated summary that core would accept must not be vetoed by the deterministic fallback's more conservative envelope estimator. The same calculation now gates both acceptance and terminal no-safe-suffix classification.

### Why an extension could not handle it

- `packages/coding-agent/src/core/agent-session.ts` owns final acceptance. Sharing its existing calculation avoids a second, divergent implementation in the builtin.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`: rejection-helper import and `_wouldCompactionOverflow` delegation.
## 2026-10-11 - Spent accounts stop retrying and compaction uses a usable model (senpi#3131)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: account-scoped failures immediately try another provider or end without backoff; the compaction resolver selects a non-spent override, current model, held target, or authenticated alternate. Published assistant errors and terminal retry errors use the shared account-limit description while the original provider text remains on internal messages and in session logs. Extension context wiring exposes the same compaction resolver.
- `packages/coding-agent/src/core/retry-fallback/candidates.ts`, `controller.ts`, `unusable.ts`, and `usage-limit.ts`: spent-provider candidates are skipped outright, account failures are retained even without a configured chain, and unavailable compaction raises the same limit description.

### Why

The prior last-resort rescan sent requests to siblings on an account already known to be spent, then normal backoff added roughly 60 seconds. Summarization selected that spent account even after a held model switch.

### Why an extension could not handle it

The retry owner, session account suppression, held-switch state, and default compaction resolver live in core.

### Expected merge conflict zones

`packages/coding-agent/src/core/agent-session.ts`: retry branches, event publication, compaction resolver, and context actions.

## 2026-10-11 - Compaction account health no longer narrows a model to never (senpi#3131 CI)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: the usability check returns a boolean rather than claiming account health determines whether an object is a `Model`. Optional candidates are checked for existence separately.

### Why

The false branch of the previous type predicate narrowed an existing session model to `never`, making the exhausted-account error fail typechecking. Test provider registrations also now include their required model names.

### Why an extension could not handle it

The invalid predicate was inside the session-owned compaction resolver.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`: `_resolveCompactionModel`.
## 2026-10-13 - Public holder endpoint evidence (senpi#3255)

### What changed

- `packages/coding-agent/src/core/agent-session-runtime.ts` carries host-owned `holderEndpoint` through initial holds and session replacement.
- Holder records add optional `host_socket`/`host_instance`. `liveSessionHolders` exposes them only after the existing process identity validation and a stable-record read; legacy records remain live without endpoint fields.
- A holder record replaced during that stable-record read now reports no `cwd` either; the pre-fence behavior published the second read's `cwd`, and the safer read is kept.

### Why

Another client needs the public endpoint of the single writer, without treating missing metadata as proof of absence.

### Why an extension could not handle it

Runtime ownership publication precedes extension attachment.

### Expected merge conflict zones

`AgentSessionLaunchProfile`, runtime hold calls, holder identity publication and listing.

## 2026-10-14 - Eval-only glob file search (#3330)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: builds the eval-only `glob` tool with the same filesystem policy as `find`, gives it the `tool.glob({ pattern: "...", path: "..." })` sample call, excludes it from the generic eval-helper list, and adds a file-name search sentence to the eval-only prompt suffix just before the grep sentence.

### Why

- `packages/coding-agent/src/core/agent-session.ts`: models inside eval called `tool.glob` and got "Unknown tool glob"; file-name search should be reachable only inside eval, like `tool.grep`.

### Why an extension could not handle it

- `packages/coding-agent/src/core/agent-session.ts` owns the builtin tool definitions, their filesystem policy wiring, and the eval-only prompt suffix.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`: `evalHelperCall`, the eval-only suffix sentences (keep grep last), and the `createAllToolDefinitions` options in `_buildRuntime`.


## 2026-10-15 - verify-api-key.ts (desktop #2510)

### What changed

New fork-only `verify-api-key.ts`. `verifyApiKey` probes the provider's model list with the key in memory and answers `ok`, `rejected` (401/403), `unreachable` (no answer, 5xx, timeout), `unsupported` (no probe for the API, or 404/405) or `unknown-provider`. Redirects are not followed, and the key never reaches a log, an error or the result. `storedKeyHint` returns the four-character hint described in the RPC tracker.

### Why

The engine half of the desktop's verify-before-save for API keys.

### Why an extension could not handle it

It serves core RPC auth commands.

### Expected merge conflict zones

None (new file).

## 2026-10-15 - verify-api-key.ts review fixes (senpi#3372 review)

### What changed

- A model list that also answers a made-up control key is public (OpenRouter, keyless local servers), so its 200 is reported `unsupported`, never `ok`. `ok` requires the control key to be refused.
- Mistral is probed at `/v1/models`.
- Configured auth headers are dropped whatever their case.
- A 3xx is `unsupported`.

### Why

A public model list made any key look valid.

### Why an extension could not handle it

It serves core RPC auth commands.

### Expected merge conflict zones

None (fork-only file).

## 2026-10-15 - verify-api-key.ts: temporary failures are unreachable (senpi#3372 delta review)

### What changed

A 429, 5xx or no answer, on either the key's request or the control request, is `unreachable` ("try again"), never `unsupported`. The control key constant moved above its use.

### Why

A rate-limited provider was told its valid key "cannot be checked".

### Why an extension could not handle it

It serves core RPC auth commands.

### Expected merge conflict zones

None (fork-only file).

## 2026-10-16 - Context files and a large skills catalog are size-bounded (senpi#3460)

### What changed

- `packages/coding-agent/src/core/context-files.ts` (new): context-file discovery moved here from `resource-loader.ts`, plus `applyContextFileLimits`. Files are budgeted nearest-first (the cwd's file, then its ancestors, then the global file): each file is cut at 64 KiB and all files together at 128 KiB, including the truncation note and any closing backtick or tilde fence. The closing marker matches the opener's character and length, and its bytes are reserved even for longer markers. Cuts prefer a newline in the last quarter of the content budget, otherwise a UTF-8 boundary. Every cut or skipped file returns a size-limit warning with its path, size and limits on the returned array's `diagnostics` property. A per-file cap below 1024 bytes is identified as too small, not blamed on nearer files. `contextFiles.maxBytesPerFile` / `contextFiles.maxTotalBytes` in settings override both.
- `packages/coding-agent/src/core/resource-loader.ts`: imports and re-exports `loadProjectContextFiles`, passes the settings limits, exposes context warnings via `getAgentsFiles().diagnostics`, and includes the returned skill-size warnings in `getSkills().diagnostics`. Neither size check prints directly.
- `packages/coding-agent/src/core/skills-prompt.ts` (new): `formatSkillsForPrompt` moved here from `skills.ts`; above 100 visible skills or 64 KiB of descriptions, each description becomes its first line, capped at 160 characters. The entire rendered section (roots and markup included) is capped at 48 KiB: compact descriptions first, names and locations only next, then the first skills that fit plus an `omitted_skills` count inside the section. Small catalogs below these limits render unchanged. The cap is fixed, not configurable.
- `packages/coding-agent/src/core/diagnostics.ts`: optional `category: "size-limit"` identifies budget warnings without matching their prose; legacy resource validation warnings remain untagged.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: context and skill size warnings share the "Context size limits" notice and a size-specific explanation. Ordinary skill diagnostics keep the skill conflicts notice.
- `packages/coding-agent/src/main.ts`: non-interactive startup reports only size-limit warnings once on stderr, prefixing the path when present. Existing skill validation warnings do not acquire new stderr output.
- `packages/coding-agent/docs/settings.md`: documents both context limits and the fixed skills-section cap beside Compaction.
- `packages/coding-agent/src/core/skills.ts`: re-exports `formatSkillsForPrompt` from `skills-prompt.ts`.
- `packages/coding-agent/src/core/settings-manager.ts`: `Settings.contextFiles`.

### Why

Context files and the skills catalog are sent on every request with no bound. On a synthetic run, one 360 KiB AGENTS.md put about 91K tokens into each call and 400 skills about 43K, so a pay-per-token run paid that on every tool turn (senpi#3460, oh-my-openagent#10305).

### Why an extension could not handle it

Context files and the skills section are assembled by core before extensions see the prompt; an extension can only rewrite the finished prompt, after the size and the warnings are already decided.

### Expected merge conflict zones

- `resource-loader.ts`: the import block and the `loadProjectContextFiles` call in `reload`.
- `skills.ts`: the area where `formatSkillsForPrompt` used to live.
- `settings-manager.ts`: the `Settings` interface beside `compaction`.

[Showing lines 10200-10857 of 10857; earlier output dropped]