/** Discover warm-eligible sessions under ~/.omp/agent/sessions. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type Config } from "./config";
import type { SessionEntry } from "./state";

export interface SessionInfo {
  id: string;
  file: string;
  cwd: string;
  model: string; // provider/model
  provider: string;
  lastUserAt: Date;
  lastAssistantAt?: Date;
  mtime: Date;
}

export function scanSessions(cfg: Config): SessionInfo[] {
  const root = cfg.sessionsRoot ?? join(ROOT, "sessions");
  const out: SessionInfo[] = [];
  if (!existsSync(root)) return out;
  // pre-filter uses the LARGEST window; per-provider windows apply post-parse
  const maxWindowH = Math.max(cfg.windowHours, ...Object.values(cfg.windowHoursByProvider));
  const cutoff = Date.now() - maxWindowH * 3_600_000;

  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let candidates: SessionInfo[] = [];
    for (const f of files) {
      const file = join(dirPath, f);
      const st = statSync(file);
      // cheap pre-filter: a session can't have a recent user message if the
      // file itself hasn't been written since the cutoff
      if (st.mtimeMs < cutoff) continue;
      const info = parseSession(file, st.mtime);
      if (!info) continue;
      const windowH = cfg.windowHoursByProvider[info.provider] ?? cfg.windowHours;
      if (info.lastUserAt.getTime() >= Date.now() - windowH * 3_600_000) candidates.push(info);
    }
    if (cfg.perProject === "latest" && candidates.length > 1) {
      candidates.sort((a, b) => b.lastUserAt.getTime() - a.lastUserAt.getTime());
      candidates = [candidates[0]];
    }
    out.push(...candidates);
  }
  return out;
}

export function parseSession(file: string, mtime: Date): SessionInfo | null {
  let id = "";
  let cwd = "";
  let model = "";
  let lastUserAt: Date | null = null;
  let lastAssistantAt: Date | null = null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const e = parsed as SessionEntry;
    if (e.type === "session" && e.id && e.cwd) {
      id = e.id;
      cwd = e.cwd;
    } else if (e.type === "model_change" && e.model) {
      model = e.model;
    } else if (e.type === "message" && e.message?.role === "user") {
      // ignore synthetic/tool-result user entries without text
      const content = e.message.content;
      const hasText =
        typeof content === "string" || (Array.isArray(content) && content.some((c) => c.type === "text"));
      if (hasText && e.timestamp) lastUserAt = new Date(e.timestamp);
    } else if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
      // a paid assistant response is the only event that touches the provider cache
      if (e.timestamp) lastAssistantAt = new Date(e.timestamp);
    }
  }
  if (!id || !model || !lastUserAt) return null;
  const provider = model.includes("/") ? model.split("/")[0] : model;
  return { id, file, cwd, model, provider, lastUserAt, lastAssistantAt: lastAssistantAt ?? undefined, mtime };
}
