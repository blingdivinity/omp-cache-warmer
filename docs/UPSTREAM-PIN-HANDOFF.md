# Handoff: upstream prefix pinning PR for oh-my-pi

Audience: a fresh agent instance working in `~/Projects/oh-my-pi` (checked out at
`7b141199d`, v17.0.7). Goal: land prefix pinning (and two smaller companions)
upstream, replacing the userland approximations in this repo
(`blingdivinity/omp-cache-warmer`).

## Why (pitch framing — lead with this in the PR description)

**Resumed sessions should see the prompt they started with.** Today omp
re-renders the system prompt on every turn: date rollover, directory changes,
extension updates, and omp version bumps silently swap the instructions
mid-conversation. That is a *consistency* problem first — earlier turns were
answered under different instructions than later turns — and a cache-cost
problem second (every drift cold-misses the whole prefix; for a 100k-token
session that is real money on resume).

Do NOT frame the PR primarily as "save cache money"; frame it as
deterministic, self-contained sessions. Cache savings fall out for free.

## Prior art proving mechanics (this repo)

- `extensions/prefix-pin.ts` — captures rendered `systemPrompt: string[]` on a
  session's first `before_agent_start`, replays it byte-for-byte thereafter
  via the event result's full-replacement semantics. Verified working:
  identical prefix across resumes → 100% `cacheRead` hits (23,939/23,941 and
  84,736/85,541 measured live).
- Known gaps of the userland version (= the reasons to upstream):
  1. Cannot pin **tool schemas** (other half of the cacheable prefix; they
     change on omp version bumps).
  2. Pin lives in a sidecar dir (`~/.omp/agent/omp-cache-warmer/pins/`), not
     in the session file — doesn't survive file moves/sync, ignorant of
     session branching.
  3. Only processes that load the plugin are protected; a session started
     before plugin install renders unpinned prompts while warm pings replay
     the pin → the two lineages diverge (observed in production: user missed
     while the warmer hit).

## Proposed upstream design

### 1. `prefix_snapshot` session entry (the core)

New entry kind in `packages/coding-agent/src/session/session-entries.ts`
(union `SessionEntry` at line ~212; follow the shape of `model_change` at
line ~72):

```ts
interface PrefixSnapshotEntry {
	type: "prefix_snapshot";
	id: string;
	parentId: string | null;
	timestamp: string;
	/** fully rendered system prompt segments at capture time */
	systemPrompt: string[];
	/** hash of the serialized tool schema set at capture time */
	toolsHash: string;
	/** omp version that rendered it (diagnostics only) */
	ompVersion: string;
}
```

Write it once, on the first agent start of a new session (after extensions
have contributed their prompt segments — i.e. capture the *final* prompt that
went to the provider, post-`emitBeforeAgentStart`).

### 2. Replay on resume

- Setting: `session.pinPrefix` — `"on" | "off" | "ask"`, default `"on"`.
- On resume, if the branch path contains a `prefix_snapshot`: use its
  `systemPrompt` instead of re-rendering. Key code paths:
  - `packages/coding-agent/src/session/agent-session.ts` — prompt lifecycle:
    `refreshBaseSystemPrompt()` (~6714, 7237, 7546), `#rebuildSystemPrompt`
    (~2073, 7436), and the `emitBeforeAgentStart` call site (search
    `emitBeforeAgentStart`; result applies via `agent.setSystemPrompt`).
  - Extension replacement must still win: apply snapshot first, then let
    `before_agent_start` handlers override (preserves existing extension
    contract; document that extensions replacing the prompt break pinning).
- Branching: snapshot is on the entry path, so branches inherit the pin of
  their fork point automatically. New sessions capture fresh.
- `/unpin` (or `/pin refresh`) command: appends a *new* `prefix_snapshot`
  from a fresh render (entries are append-only; latest snapshot on path wins).

### 3. Tool-schema drift detection (the part userland cannot do)

Full tool replay is likely over-engineering (tools are code, not data). The
pragmatic version:

- Compute `toolsHash` at capture (agent-session already has a serialized
  tool-signature concept — see the `#J5` cache-key builder in the bundled
  dist, `tool name=label|description|wireName...`; find its source near the
  `rebuildSystemPrompt` skip-optimization around line 957–970).
- On resume with a pin, if current `toolsHash` differs: notify once
  ("tool set changed since this session started (omp upgrade?) — prefix
  cache will re-prime; /unpin to also refresh the prompt"). Do NOT block.

### 4. Companion (separate small PR): `cacheRetention` as a real setting

- Today env-only: `packages/ai/src/utils.ts` ~291–299 (`PI_CACHE_RETENTION`,
  default `"short"`). There is already an awareness comment in
  `packages/ai/src/providers/anthropic.ts:519` about cold-missing the prefix
  on resume.
- Add settings key (suggest `provider.cacheRetention`), env still wins.
  Optionally argue default `"long"` for interactive sessions (cost: 2× vs
  1.25× on cache writes; benefit: sessions idling >5min — i.e. nearly all
  human sessions — stop cold-missing). Keep the default flip as a separate
  commit so it can be dropped in review without losing the settings key.

### 5. Companion (optional, cheap): predicted-cache-state surface

`usage.cacheRead`/TTL are already tracked; expose "predicted cache alive
until T" on the session (status-bar segment `cache_hit` already exists).
Enables miss warnings without sidecar mtime math (see
`extensions/miss-guard.ts` here for the UX it unlocks: confirm-before-miss).

## Validation plan (do these before opening the PR)

1. Unit: session-entries round-trip for the new entry; migration no-op for
   old sessions (absent snapshot = legacy behavior).
2. Behavior: create session → resume next "day" (fake `Date`) → assert
   provider request systemPrompt is byte-identical to first turn's.
3. Cache proof (manual, cheap): the harness in this repo —
   `src/index.ts warm <id>` against a real session copy; a pinned resume must
   log `cache HIT ~100%`. Anthropic reports `cacheRead` in usage; 0 = fail.
4. Extension interplay: an extension returning `systemPrompt` from
   `before_agent_start` must still override (existing test dir:
   `packages/coding-agent/src/extensibility/`).
5. Branch/fork: fork a pinned session; both branches replay the same pin.

## Repo conventions to respect

- Read `~/Projects/oh-my-pi/AGENTS.md` and `CONTRIBUTING.md` first.
- Monorepo: `packages/coding-agent` (session/agent), `packages/ai`
  (providers). Biome for lint/format; `bun` everywhere.
- Session file format is versioned (`session-migrations.ts`) — adding an
  entry type has precedent; check how prior entry kinds handled version
  bumps (grep `version: 3` in `session-persistence.ts` / header type ~28).

## Landmines learned building the userland version

- The Anthropic hit test needs `>=0.5 cacheRead/input` tolerance, not
  equality — a couple of tokens (the new user message) are always uncached.
- `Bun.env` is read live per-request for `PI_CACHE_RETENTION` — safe to set
  in-process, but that trick dies if utils.ts ever snapshots env at import.
- First warm/resume after a TTL gap is a *legitimate* cold re-prime, not a
  drift — any "prefix changed" detection must only compare renders, never
  infer from cache misses alone (we made that mistake; see this repo's
  `expectHit` logic for the correction).
- Date is embedded in the default prompt ("Today is …"), so an unpinned
  session drifts at midnight — good cheap test case for the replay path.

## Definition of done

- [ ] `prefix_snapshot` written on new sessions, replayed on resume by default
- [ ] `session.pinPrefix` setting (`on|off|ask`) + `/unpin` command
- [ ] `toolsHash` drift notice
- [ ] docs: session-format doc + settings reference updated
- [ ] tests: round-trip, resume-replay, extension-override, branch-inherit
- [ ] separate PR: `provider.cacheRetention` settings key
- [ ] after merge: strip `prefix-pin.ts` from omp-cache-warmer (keep warmer
      daemon + miss-guard; miss-guard migrates to the predicted-cache API if
      #5 lands)

## Addendum (2026-07-22): the idle-flush collision — a fourth upstream item

Root cause of a production full-miss, found in
`packages/coding-agent/src/session/agent-session.ts`:

```ts
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;
// "Idle gap after which the supersede pass may flush the whole sent region
//  (the provider cache is cold, so re-writing it is free)."
```

A live omp process idle >90m rewrites its sent history on the next message
(prunes superseded tool results — NO compaction entry is written). The
"cache is cold anyway" assumption is inverted by an external warmer: we
measured a 222k-token prefix, verified warm 45 min earlier (usage.cacheRead
= 221,984), fully missed (cacheRead 0) because the flush changed the request
bytes. Warm-vs-warm stayed consistent (resumed copies don't carry the live
process's prune bookkeeping), proving the rewrite is process-local state.

Upstream proposal (smallest first):
1. Make `PRUNE_IDLE_FLUSH_MS` a setting (`prune.idleFlushMs`), so cache-warming
   setups can raise/disable it.
2. Better: gate the flush on *predicted cache state* rather than idle time
   alone — the session knows its provider TTL and its last request timestamp;
   with an external-warm signal (or simply a longer configured retention) the
   flush is not "free" and should be skipped or deferred until the next
   natural cache re-prime.
3. With prefix pinning (`prefix_snapshot`) landed, consider making the flush
   itself deterministic from file state, so live and resumed renderings can
   never diverge.

## Addendum 2: expose rewind on the plain extension context (item 5)

Live self-warming (ping + rewind inside the live process — see
`extensions/live-warm.ts`, validated at ~99% post-rewind cache retention)
requires `navigateTree`/`waitForIdle`, which only exist on
`ExtensionCommandContext`. Probed at runtime: event handlers really do get
the narrow context, so automation needs a per-session `/livewarm-on` to
capture a command context (which, notably, stays valid after the command
returns — arguably that leak IS the API, so widening the event context just
acknowledges reality). Ask: promote `navigateTree` + `waitForIdle` to
`ExtensionContext`.
