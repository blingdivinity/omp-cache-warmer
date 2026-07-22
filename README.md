# omp-cache-warmer

**Keep your [oh-my-pi](https://github.com/nicobrenner/oh-my-pi) sessions' prompt caches warm — resume hours later and pay cache-read prices, not cold re-reads.**

Provider prompt caches are short-lived (Claude Code is 1h). Walk away from a 600k-token session for lunch and your next message re-reads the entire prefix at full price. This project fixes that with three cooperating pieces:

| Piece | Runs where | Job |
|---|---|---|
| **Warmer daemon** | launchd (macOS) / systemd user unit (Linux) | Pings idle sessions on a per-provider schedule so live caches never expire |
| **prefix-pin extension** | every omp process | Freezes each session's rendered system prompt so the prefix never drifts; upgrades Anthropic sessions to the 1 h cache tier |
| **miss-guard extension** | interactive omp sessions | Predicts when your next message would cold-miss and asks before you pay |

## Install

```bash
git clone https://github.com/blingdivinity/omp-cache-warmer
omp plugin link ./omp-cache-warmer          # extensions: pinning + miss-guard + /warm-* commands
cd omp-cache-warmer && bun src/index.ts install   # daemon: launchd on macOS, systemd --user on Linux
```

The Linux installer also enables user lingering (or tells you the `sudo loginctl enable-linger` command) so the daemon runs without an SSH session.

## How warming works

The daemon scans `~/.omp/agent/sessions` every minute for sessions whose last user message is within the warm window (default **24 h**). When a session has been idle longer than its provider's interval, it re-sends the session's **exact prompt prefix** with a trivial `Respond with only: OK` message, refreshing the provider-side cache TTL.

**Your session history never grows.** Each warm resumes a *temporary copy* of the session file with a throwaway `--session-dir` — same system prompt, same tools, same history, same model → byte-identical prefix → cache refreshed, real `.jsonl` untouched.

**Every warm is verified.** The response's `usage.cacheRead` is checked: ~100 % confirms the prefix still matches. Outcomes land in an append-only ledger (`history.jsonl`); `stats` summarizes hits, drifts, and token totals.

### Intervals

| Provider | Interval | Why |
|---|---|---|
| `anthropic` | 55 min | 1 h cache TTL, refreshed with 5 min safety margin |
| `openai-codex` | 8 h 01 m | fires twice inside the 24 h window (8h01m, 16h02m) |
| everything else | 55 min (`defaultIntervalMinutes`) | configurable per provider prefix |

### Keeper, not reviver

There is no free way to ask a provider "does this cache still exist?" — cache status only comes back in the usage of a *paid* request. The warmer predicts expiry from TTL math (it knows exactly when each cache was last touched). With the default `coldReprime: "never"`, a cache that is predicted expired is **left cold**: the session is disabled with a logged reason and zero spend. Cold prefixes are only re-primed deliberately —

- you send a real message (guarded by miss-guard if it's big), or
- you run `omp-cache-warmer warm <id>`, which re-primes *and* re-enrolls the session.

Set `coldReprime` to a token count (re-prime automatically when the prefix is at most that big) or `"always"` if you want reviver behavior.

## Prefix pinning

Warming is pointless if the prefix changes underneath you. omp re-renders the system prompt every turn — the date line, directory state, and extension changes all shift it, and every shift cold-misses the whole prefix.

`extensions/prefix-pin.ts` freezes it:

1. A session's **first turn captures** the fully rendered system prompt to `~/.omp/agent/omp-cache-warmer/pins/<session-id>.json`.
2. **Every later turn replays it byte-for-byte** — interactive resumes *and* warmer pings, which load the same extension. Date rollover, renamed directories, prompt tweaks: none of it moves the prefix anymore.
3. **Pins never expire.** Even a cold-cached session resumes onto its original prefix, so the re-prime you pay is for the *same stable lineage*, not a freshly drifted one. Pins unused for 60 days are pruned (a later resume simply re-pins).

The extension also sets `PI_CACHE_RETENTION=long` in-process (unless you set it yourself), upgrading Anthropic sessions from 5-minute to 1-hour cache entries — without which the 55 min warm interval could never work.

In-session: `/pin-status`, `/pin-refresh` (drop the pin after intentionally changing your setup).

**Limits:** tool schemas are the one prefix component an extension cannot pin; they change on omp version bumps and cost one re-prime each. See `docs/UPSTREAM-PIN-HANDOFF.md` for the upstream `prefix_snapshot` proposal that closes this gap.

## Miss guard

`extensions/miss-guard.ts` runs the same TTL math as the daemon on every message you submit. If the cache is predicted **expired** and the prefix is **≥ 40k tokens** (`missConfirmTokens`), you get a yes/no dialog before anything is sent:

> **Predicted prompt-cache MISS** — this session has been idle ~87m; sending will re-read ~85,541 tokens uncached. Send anyway?

Declining restores your typed message to the editor. Predicted-warm sends and small cold sends pass through silently.

## Prefix drift

Warm pings rebuild the prompt through the same code path a real resume uses, so drift is detected and self-heals:

- **One-off drift** (omp updated, extension changed the prompt): one warm misses, and by missing **re-primes the new prefix** — the exact one your next resume sends. Logged as `prefix DRIFT`, shown as `drifts=N` in `status`.
- **Constant drift** (prompt embeds churning content): two consecutive drifts auto-disable the session — correct, because a real resume would miss anyway and money shouldn't be spent pretending otherwise.
- With pinning active, both cases essentially disappear.

## CLI

```
omp-cache-warmer status            sessions in the warm window, schedule, hit stats (default)
omp-cache-warmer once              single sweep
omp-cache-warmer daemon            run forever (sweeps every minute)
omp-cache-warmer warm <id>         force-warm one session now (re-primes + re-enables)
omp-cache-warmer enable <id>       re-enable a disabled session
omp-cache-warmer stats             hit/miss ledger summary
omp-cache-warmer install           install launchd agent (macOS) / systemd user unit (Linux)
omp-cache-warmer uninstall         remove it
omp-cache-warmer config            show config path + contents
```

(Run via `bun src/index.ts <cmd>` from a checkout, or the `omp-cache-warmer` bin if installed.)

The background service is named so future-you knows what it is: `com.oh-my-pi.keep-ai-prompt-cache-warm` (launchd) / `omp-keep-ai-prompt-cache-warm.service` (systemd).

## Configuration

`~/.omp/agent/omp-cache-warmer/config.json` (created on first run, re-read every sweep and every miss-guard check — edits apply live):

```jsonc
{
  "windowHours": 24,               // keep warming this long after the last user message
  "intervals": {                   // minutes, keyed by provider prefix of the model id
    "anthropic": 55,
    "openai-codex": 481
  },
  "defaultIntervalMinutes": 55,
  "message": "Respond with only: OK",
  "perProject": "latest",          // "latest" = newest session per project dir, or "all"
  "maxWarmsPerSweep": 4,
  "warmTimeoutSeconds": 300,
  "coldReprime": "never",          // "never" | "always" | max tokens to auto-revive a cold cache
  "missConfirmTokens": 40000,      // miss-guard dialog threshold; false disables the dialog
  "pinPrefixes": true,             // prefix pinning on/off
  "exclude": [],                   // session id prefixes to never warm
  "ompBin": "omp"
}
```

Sibling files: `state.json` (per-session warm state), `history.jsonl` (ledger), `pins/` (frozen prompts), `warmer.log` / `warmer.launchd.log` (logs; `journalctl --user -u omp-keep-ai-prompt-cache-warm` on Linux).

In-session commands: `/warm-status`, `/warm-off`, `/pin-status`, `/pin-refresh`.

## Cost model

- A scheduled warm = one cache **read** of the prefix (0.1× input price on Anthropic) + a few output tokens. Warming a 24k-token session hourly for a day costs roughly one uncached request over it.
- A drift or forced re-prime = one cache **write** (1.25×/2× input price) — visible in `stats` as `cacheWrite`.
- An unguarded cold resume of a big session = the thing this project exists to prevent.

## Edge cases, honestly

- **Active sessions warm themselves** — the daemon watches file mtime and stays out of the way until you've been idle a full interval.
- **Drift between the last warm and your resume** (you rename files, then resume a minute later, without pinning) cannot be pre-warmed by anything: the new prefix doesn't exist until you send it.
- **Sessions started before the plugin was installed** are unprotected until restarted (`omp -c`): they render unpinned prompts on the 5-minute tier while the warmer faithfully keeps a lineage they no longer send. Restarting aligns them with the pin.

## License

MIT
