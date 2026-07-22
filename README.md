# omp-cache-warmer

Keeps your oh-my-pi sessions' prompt caches warm so resuming a session hours later is instant and cheap.

## How it works

A standalone daemon (works even when omp isn't running) scans `~/.omp/agent/sessions` for sessions whose last user message is within the warm window (default **24h**). On a per-provider interval it re-sends the session's **exact prompt prefix** with a trivial `Respond with only: OK` message, which refreshes the provider-side cache TTL.

**Your session history never grows.** Instead of appending pings and rewinding, each warm resumes a *temporary copy* of the session file with a throwaway `--session-dir` — same system prompt, same tools, same history, same model → identical prefix → cache refreshed. The real `.jsonl` is never touched.

**Prefix verification.** After each warm, the response's `usage.cacheRead` is checked. A 100% hit confirms the prefix still matches byte-for-byte. If the server reports a cold cache twice in a row when a hit was expected, the session is auto-disabled (`prefix mismatch`) — e.g. because an extension changed the system prompt. A cold *re-prime* after expiry is fine and expected.

## Intervals

| Provider | Interval | Why |
|---|---|---|
| `anthropic` | 55 min | 1h cache TTL, refreshed with 5 min of safety margin |
| `openai-codex` | 8h 01m | fires twice inside the 24h window (8h01m, 16h02m) |
| everything else | 55 min (`defaultIntervalMinutes`) | configurable |

> **Anthropic note:** omp defaults to the 5-minute cache tier (`cacheRetention: short`). The plugin fixes this everywhere: the prefix-pin extension sets `PI_CACHE_RETENTION=long` at load (unless you set it yourself), so interactive sessions write **1-hour** entries, and the warmer's pings do the same. Sessions started *before* the plugin was installed keep the 5-minute tier until restarted (`omp -c`).

## Usage

```bash
bun src/index.ts status        # what would be warmed, when (default command)
bun src/index.ts once          # single sweep
bun src/index.ts daemon        # run forever, sweeps every minute
bun src/index.ts warm <id>     # force-warm one session now
bun src/index.ts enable <id>   # re-enable after a prefix-mismatch disable
bun src/index.ts install       # install as macOS launchd agent (auto-start, keep-alive)
bun src/index.ts uninstall
bun src/index.ts config        # show config path + contents
```

## Config

`~/.omp/agent/omp-cache-warmer/config.json` (created on first run):

```jsonc
{
  "windowHours": 24,               // keep warming this long after the last user message
  "intervals": {                   // minutes, keyed by provider prefix of the model id
    "anthropic": 55,
    "openai-codex": 481
  },
  "defaultIntervalMinutes": 55,
  "message": "Respond with only: OK",
  "perProject": "latest",          // "latest" = newest session per project, or "all"
  "maxWarmsPerSweep": 4,
  "warmTimeoutSeconds": 300,
  "coldReprime": "never",         // "always" | "never" | max tokens: warmer only KEEPS caches warm
  "exclude": [],                   // session id prefixes to skip
  "ompBin": "omp"
}
```

### Cold re-prime guard

No provider offers a free "does this cache still exist?" probe — cache status only comes back in the usage of a *paid* request. So the warmer predicts expiry from TTL math (it knows exactly when it last refreshed each cache). When a cache is predicted expired, re-warming means paying a full cache *write* over the whole prefix. `coldReprime` bounds that: expired sessions whose estimated prefix exceeds the limit are disabled with a logged reason instead of silently billed. Override per session with `omp-cache-warmer warm <id>` (a successful forced warm re-enables it) or `omp-cache-warmer enable <id>`.

### Prefix drift (omp updates, date rollover, changed files)

Each warm rebuilds the prompt through the **same code path a real resume uses** — current omp version, current date, current directory state, same cwd. It does not replay a frozen prefix. Consequences:

- **One-off drift** (omp updated, system date rolled over, an extension changed the prompt): the next warm misses against the old cache and, by missing, **re-primes the cache with the new prefix** — the exact prefix your future resume will send. Cost: one cache write, absorbed by a ping. Logged as `prefix DRIFT`, counted in `status` as `drifts=N`.
- **Constant drift** (system prompt embeds churning content — directory tree, timestamps): two consecutive drifts auto-disable the session with reason `prefix unstable`. This is correct: if the prefix changes every interval, a real resume would miss anyway — warming can't help, and money shouldn't be spent pretending it can.
- **Unavoidable window**: drift that happens *between the last warm and your resume* (you rename files, then resume minutes later) can't be pre-warmed by anything — the new prefix doesn't exist until you send it.

### Prefix pinning (freezing the prompt)

`extensions/prefix-pin.ts` eliminates drift at the source. omp's `before_agent_start` event exposes the fully rendered system prompt and lets an extension replace it, so:

1. The first turn of a session **captures** the rendered prompt into `~/.omp/agent/omp-cache-warmer/pins/<session-id>.json`.
2. Every later turn — interactive resumes *and* warmer pings (both load the same extension) — **replays the pinned prompt byte-for-byte**. Date rollover, directory-tree changes, and prompt tweaks no longer change the prefix.
3. **Pins never expire.** Every resumed session — even one whose cache went cold — replays its original prefix; a cold resume then re-primes the *same stable prefix* instead of a freshly drifted one. Unused pins are pruned after 60 days (a later resume simply re-pins). Disable globally with `"pinPrefixes": false`; re-capture per session with `/pin-refresh`.

In-session commands: `/pin-status` (age + size), `/pin-refresh` (drop the pin; next turn re-captures — use after intentionally changing your setup).

**Upstream gap:** tool schemas are the one prefix component an extension cannot pin — they change on omp version bumps. A complete freeze would need upstream support (e.g. a `session.freezePrefix` setting that also replays recorded tool schemas on resume). With pinning, an omp upgrade costs exactly one drift re-prime per session; everything else is frozen.

State (last warm time, hit stats, disables) lives in `state.json` next to it; logs in `warmer.log`.

An **active** omp session warms itself — the daemon watches file mtime and only pings once the session has been idle longer than the interval.

## Companion extension (optional)

`extensions/warmer.ts` adds in-session commands:

- `/warm-status` — when this session was last warmed and its cache-hit size
- `/warm-off` — exclude this session from warming

The daemon is the source of truth; the extension is just a convenience view.

## Cost

Each warm costs one cache-read of your prefix plus a couple of output tokens. On Anthropic, cache reads are 0.1× input price — warming a 24k-token session hourly for 24h costs roughly the same as *one* uncached request over it.
