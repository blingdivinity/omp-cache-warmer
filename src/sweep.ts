/** The sweep: decide which sessions to warm, warm them, classify outcomes. */

import { appendFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, HISTORY_PATH, log, type Config } from "./config";
import { scanSessions, type SessionInfo } from "./scan";
import { loadState, saveState, type SessionState } from "./state";
import { warmSession, type WarmResult } from "./warm";

function prunePins(now: number) {
  // housekeeping: pins never expire logically, but drop ones whose session
  // hasn't been touched in 60 days (a re-resume simply re-pins fresh)
  const pinsDir = join(DATA_DIR, "pins");
  if (!existsSync(pinsDir)) return;
  for (const f of readdirSync(pinsDir)) {
    const p = join(pinsDir, f);
    try {
      if (now - statSync(p).mtimeMs > 60 * 86_400_000) rmSync(p, { force: true });
    } catch {}
  }
}

function ompVersion(cfg: Config): string {
  try {
    const r = Bun.spawnSync([cfg.ompBin, "--version"]);
    return r.stdout.toString().trim();
  } catch {
    return "";
  }
}

function classifyDrift(s: SessionInfo, st: SessionState, res: WarmResult, prevWarmAt: number, upgraded: boolean) {
  // Distinguish two drift causes:
  //  - file UNCHANGED since our last warm => the request pipeline itself renders
  //    differently now (omp update, extension change) OR a live omp process
  //    rewrote its in-memory context (idle-flush) — lineage-level divergence.
  //  - file CHANGED => real content drift (new messages, compaction).
  const fileUnchanged = prevWarmAt > 0 && s.mtime.getTime() <= prevWarmAt;
  if (upgraded) {
    // systemic one-time event: the omp upgrade changed the rendered prefix
    // (tool schemas etc.) for EVERY session — expected, don't punish it
    st.misses = 0;
    st.driftEvents = (st.driftEvents ?? 0) + 1;
    log(
      `  prefix re-primed after omp upgrade (${res.cacheRead}/${res.input} cached, ` +
        `wrote ${res.cacheWrite}) — not counted toward disable`,
    );
    return;
  }
  st.misses++;
  // driftEvents is a 24h-windowed counter: a drift older than 24h (or none) starts
  // a fresh window, otherwise it accumulates. misses stays the consecutive-warm gauge.
  const prevDriftAt = st.lastDriftAt ? Date.parse(st.lastDriftAt) : 0;
  const withinWindow = prevDriftAt > 0 && Date.now() - prevDriftAt < 24 * 60 * 60 * 1000;
  st.driftEvents = withinWindow ? (st.driftEvents ?? 0) + 1 : 1;
  st.lastDriftAt = new Date().toISOString();
  log(
    `  prefix DRIFT${fileUnchanged ? " (file unchanged — lineage divergence)" : ""}: ` +
      `expected hit, got ${res.cacheRead}/${res.input} cached ` +
      `(re-primed new prefix, wrote ${res.cacheWrite} tokens) — drift ${st.misses}/2 consecutive`,
  );
  if (fileUnchanged) {
    st.disabled =
      "lineage divergence: warm request changed while the session file did not " +
      "(omp/extension update, or a live omp process rewrote its context after long idle). " +
      "Warming paused; a fresh resume or /compact re-aligns, then: omp-cache-warmer warm <id>";
    log(`  disabled ${s.id.slice(0, 8)}: ${st.disabled}`);
  } else if (st.misses >= 2) {
    st.disabled =
      "prefix unstable: changed between consecutive warms twice — warming is futile " +
      "(a real resume would miss too); likely dynamic system prompt content (date, dir tree, extensions)";
    log(`  disabled ${s.id.slice(0, 8)}: ${st.disabled}`);
  } else if ((st.driftEvents ?? 0) >= 3) {
    st.disabled =
      "chronic drift: 3 full-miss warms within 24h despite interleaved self-hits — " +
      "the daemon's rendering diverges from this session's; warming paused (live-warm covers open sessions). " +
      `Force with: omp-cache-warmer warm ${s.id.slice(0, 8)}`;
    log(`  disabled ${s.id.slice(0, 8)}: ${st.disabled}`);
  }
}

function preflightDrift(s: SessionInfo, st: SessionState) {
  // Pre-flight drift: the pin extension detected that the daemon's rendered
  // system prompt diverges from the live session's and aborted at 0 tokens.
  // Count it in the SAME 24h window classifyDrift uses, but don't touch
  // st.misses — no expected-hit was paid, so the consecutive-miss gauge is
  // irrelevant here. Detection is free, so we only disable on chronic drift.
  const prevDriftAt = st.lastDriftAt ? Date.parse(st.lastDriftAt) : 0;
  const withinWindow = prevDriftAt > 0 && Date.now() - prevDriftAt < 24 * 60 * 60 * 1000;
  st.driftEvents = withinWindow ? (st.driftEvents ?? 0) + 1 : 1;
  st.lastDriftAt = new Date().toISOString();
  log(`  pre-flight drift: warm rendering != live — aborted, 0 tokens (drift ${st.driftEvents}/3 in 24h)`);
  if ((st.driftEvents ?? 0) >= 3) {
    st.disabled =
      "chronic pre-flight drift: 3 aborts within 24h — the daemon's rendering diverges from this session's " +
      "system prompt. Pre-flight detection is free so repeated aborts are cheap, but pointless; warming paused " +
      "(a fresh resume/compact re-aligns). Force with: omp-cache-warmer warm " +
      s.id.slice(0, 8);
    log(`  disabled ${s.id.slice(0, 8)}: ${st.disabled}`);
  }
}

export async function sweep(cfg: Config, opts: { force?: string } = {}): Promise<void> {
  const version = ompVersion(cfg);
  const state = loadState();
  const sessions = scanSessions(cfg);
  const now = Date.now();
  let warmed = 0;
  prunePins(now);

  for (const s of sessions) {
    const st = (state[s.id] ??= { misses: 0 });
    const forced = opts.force && s.id.startsWith(opts.force);
    const interval = (cfg.intervals[s.provider] ?? cfg.defaultIntervalMinutes) * 60_000;
    if (!forced) {
      if (st.disabled) continue;
      if (cfg.exclude.some((p) => s.id.startsWith(p))) continue;
      // clock starts at the later of: last real user message, our last warm,
      // or the file's mtime (an active omp session keeps its own cache warm)
      const lastActivity = Math.max(
        s.lastUserAt.getTime(),
        st.lastWarmAt ? Date.parse(st.lastWarmAt) : 0,
        s.mtime.getTime(),
      );
      if (now - lastActivity < interval) continue;
      if (warmed >= cfg.maxWarmsPerSweep) continue;
    }
    // a hit is only expected if the cache should still be alive: our last warm
    // (or the session's own activity) happened within the interval + slack.
    // No provider offers a free "does this cache exist" probe — status only
    // arrives in the usage of a paid request — so we predict from TTL math.
    const lastTouch = Math.max(st.lastWarmAt ? Date.parse(st.lastWarmAt) : 0, s.mtime.getTime());
    let expectHit = now - lastTouch < interval + 10 * 60_000;

    // drift re-prime loop: last warm was a full miss (lastCacheRead 0) and the
    // session file has new live activity since. The live session owns the cache
    // now; our resume rendering already proved divergent, so re-warming would
    // repeat the same full-price miss. Gate it like a cold re-prime.
    if (!forced && st.lastCacheRead === 0 && st.lastWarmAt && s.mtime.getTime() > Date.parse(st.lastWarmAt)) {
      const estTokens = st.lastInputTokens ?? Math.round(statSync(s.file).size / 4);
      if (cfg.coldReprime === "never" || (cfg.coldReprime !== "always" && estTokens > cfg.coldReprime)) {
        st.disabled =
          `drift re-prime loop: last warm missed fully and the session has new live activity — ` +
          `re-warming would pay ~${estTokens} tokens again for a rendering the live session doesn't use. ` +
          `Re-aligns on a fresh resume/compact; force with: omp-cache-warmer warm ${s.id.slice(0, 8)}`;
        log(`skipping ${s.id.slice(0, 8)}: ${st.disabled}`);
        continue;
      }
      // proceeding under coldReprime "always"/under-threshold: this is a known
      // re-prime, not a surprise drift — don't let a full miss count as drift.
      expectHit = false;
    }

    if (!expectHit && !forced && cfg.coldReprime !== "always") {
      // estimate prefix size: exact from the last warm, else ~chars/4
      const estTokens = st.lastInputTokens ?? Math.round(statSync(s.file).size / 4);
      if (cfg.coldReprime === "never" || estTokens > cfg.coldReprime) {
        st.disabled = `cache predicted expired; cold re-prime ~${estTokens} tokens exceeds coldReprime (${cfg.coldReprime})`;
        log(`skipping ${s.id.slice(0, 8)}: ${st.disabled} — force with: omp-cache-warmer warm ${s.id.slice(0, 8)}`);
        continue;
      }
    }

    const prevWarmAt = st.lastWarmAt ? Date.parse(st.lastWarmAt) : 0;
    const upgraded = Boolean(version && st.ompVersion && st.ompVersion !== version);
    log(`warming ${s.id.slice(0, 8)} (${s.model}, cwd=${s.cwd})`);
    const res = await warmSession(cfg, s);
    warmed++;
    const warmTs = new Date().toISOString();
    if (!res.skipped) {
      // nothing touched the cache on a pre-flight abort — leave the
      // last-warm gauges untouched so TTL/expiry math is unaffected
      st.lastWarmAt = warmTs;
      if (version) st.ompVersion = version;
      st.lastCacheRead = res.cacheRead;
      st.lastCacheWrite = res.cacheWrite;
      st.lastInputTokens = res.input;
    }
    const outcome = res.skipped
      ? "preflight-drift"
      : !res.ok
        ? "failed"
        : res.input > 0 && res.cacheRead / res.input >= 0.5
          ? "hit"
          : expectHit ? "drift" : "reprime";
    try {
      appendFileSync(
        HISTORY_PATH,
        JSON.stringify({
          ts: warmTs,
          session: s.id,
          model: s.model,
          outcome,
          cacheRead: res.cacheRead,
          cacheWrite: res.cacheWrite,
          input: res.input,
          forced: Boolean(forced),
        }) + "\n",
      );
    } catch {}
    if (res.skipped) {
      preflightDrift(s, st);
      continue; // free abort: cache untouched, nothing more to do
    }
    if (!res.ok) {
      log(`  warm failed: ${res.detail}`);
      continue; // transient failure: don't count as prefix miss
    }
    if (outcome === "hit") {
      st.misses = 0;
      // a HIT proves the rendering re-aligned: clear the expiry gate always,
      // and any drift/divergence disable when the user explicitly forced.
      if (st.disabled && (forced || st.disabled.startsWith("cache predicted expired"))) delete st.disabled;
      log(`  cache HIT ${((res.cacheRead / res.input) * 100).toFixed(1)}% (${res.cacheRead}/${res.input} tokens)`);
    } else if (outcome === "drift") {
      classifyDrift(s, st, res, prevWarmAt, upgraded);
    } else {
      if (st.disabled?.startsWith("cache predicted expired")) delete st.disabled;
      log(`  cold re-prime (${res.cacheRead}/${res.input} cached) — cache rewritten with fresh TTL`);
    }
  }
  saveState(state);
}
