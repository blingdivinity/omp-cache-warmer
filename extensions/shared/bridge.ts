/**
 * In-process bridge between the miss-guard and live-warm extensions.
 * Both entry files import this module; the module cache makes it a singleton
 * per omp process, so miss-guard can trigger a live-warm cycle when the user
 * picks "warm first" in the miss dialog.
 */

export interface LiveWarmBridge {
  /** Run one ping+rewind cycle. Returns true on success. Set by live-warm once a command context is armed. */
  runPing?: () => Promise<boolean>;
}

export const liveWarmBridge: LiveWarmBridge = {};
