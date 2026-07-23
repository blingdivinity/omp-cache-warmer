/** Execute one warm: resume a temp copy of a session and read the usage. */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "./config";
import type { SessionInfo } from "./scan";
import type { SessionEntry } from "./state";

export interface WarmResult {
  ok: boolean;
  skipped?: boolean;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  detail: string;
}

export async function warmSession(cfg: Config, s: SessionInfo): Promise<WarmResult> {
  const tmp = mkdtempSync(join(tmpdir(), "omp-cache-warmer-"));
  try {
    const copy = join(tmp, basename(s.file));
    cpSync(s.file, copy);
    const cwd = existsSync(s.cwd) ? s.cwd : process.cwd();
    const proc = Bun.spawn(
      [cfg.ompBin, "-r", copy, "-p", cfg.message, "--session-dir", tmp, "--no-title", "--cwd", cwd],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        // rewrite the prefix as a 1h-TTL cache entry on Anthropic
        env: { ...process.env, PI_CACHE_RETENTION: "long", OMP_CACHE_WARMER_WARM: "1" },
      },
    );
    const killer = setTimeout(() => proc.kill(), cfg.warmTimeoutSeconds * 1000);
    const exit = await proc.exited;
    clearTimeout(killer);
    if (exit !== 0) {
      if (exit === 93) {
        // the pin extension detected system-prompt drift against the live
        // session and aborted before the paid request — no cache touched
        return {
          ok: false,
          skipped: true,
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          detail: "pre-flight drift: warm rendering differs from live — aborted before the paid request",
        };
      }
      const err = await new Response(proc.stderr).text();
      return { ok: false, cacheRead: 0, cacheWrite: 0, input: 0, detail: `omp exited ${exit}: ${err.slice(-400)}` };
    }
    // find the warm response usage in whichever jsonl in tmp grew
    const usage = extractLastUsage(tmp);
    if (!usage) {
      return { ok: false, cacheRead: 0, cacheWrite: 0, input: 0, detail: "no assistant usage found in warm output" };
    }
    return { ok: true, ...usage, detail: "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function extractLastUsage(dir: string): { cacheRead: number; cacheWrite: number; input: number } | null {
  let best: { cacheRead: number; cacheWrite: number; input: number } | null = null;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith(".jsonl")) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.includes('"usage"')) continue;
          try {
            const parsed = JSON.parse(line) as SessionEntry;
            const u = parsed.message?.usage;
            if (parsed.type === "message" && parsed.message?.role === "assistant" && u) {
              best = {
                cacheRead: u.cacheRead ?? 0,
                cacheWrite: u.cacheWrite ?? 0,
                input: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
              };
            }
          } catch {}
        }
      }
    }
  };
  walk(dir);
  return best;
}
