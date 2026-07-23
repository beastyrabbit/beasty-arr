import type { FastifyBaseLogger } from "fastify";

export type JobDefinition = {
  name: string;
  /** Interval between runs. For "nightly" style jobs use intervalMs: 24h and an alignment hour. */
  intervalMs: number;
  /** Optional UTC hour (0-23) to align the first run to (e.g. nightly reconcile at 03:00). */
  alignToUtcHour?: number;
  /** Jitter fraction (0..1) applied to each scheduled delay. Default 0.05. */
  jitter?: number;
  run: (signal: AbortSignal) => Promise<void>;
};

type JobState = {
  def: JobDefinition;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
};

/**
 * Minimal in-process scheduler: single-flight per job, jittered delays,
 * no external dependencies. Jobs must be idempotent.
 */
export class Scheduler {
  private readonly jobs = new Map<string, JobState>();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  registerJob(def: JobDefinition): void {
    if (this.jobs.has(def.name)) throw new Error(`Job already registered: ${def.name}`);
    const state: JobState = { def, timer: null, running: false, lastRunAt: null, lastError: null };
    this.jobs.set(def.name, state);
    this.schedule(state, this.initialDelay(def));
  }

  /** Run a job immediately (out of schedule). No-op if already running. */
  async trigger(name: string): Promise<boolean> {
    const state = this.jobs.get(name);
    if (!state || state.running) return false;
    await this.execute(state);
    return true;
  }

  status(): {
    name: string;
    running: boolean;
    lastRunAt: number | null;
    lastError: string | null;
  }[] {
    return [...this.jobs.values()].map((s) => ({
      name: s.def.name,
      running: s.running,
      lastRunAt: s.lastRunAt,
      lastError: s.lastError,
    }));
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    for (const state of this.jobs.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private initialDelay(def: JobDefinition): number {
    if (def.alignToUtcHour === undefined)
      return this.jittered(Math.min(def.intervalMs, 15_000), def);
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(def.alignToUtcHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  private schedule(state: JobState, delayMs: number): void {
    if (this.stopped) return;
    state.timer = setTimeout(() => {
      void this.execute(state).finally(() => {
        this.schedule(state, this.jittered(state.def.intervalMs, state.def));
      });
    }, delayMs);
    state.timer.unref?.();
  }

  private jittered(ms: number, def: JobDefinition): number {
    const jitter = def.jitter ?? 0.05;
    const delta = ms * jitter * (Math.random() * 2 - 1);
    return Math.max(1000, Math.round(ms + delta));
  }

  private async execute(state: JobState): Promise<void> {
    if (state.running || this.stopped) return;
    state.running = true;
    const started = Date.now();
    try {
      await state.def.run(this.abort.signal);
      state.lastError = null;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      this.log.error({ job: state.def.name, err: error }, "scheduled job failed");
    } finally {
      state.running = false;
      state.lastRunAt = started;
    }
  }
}
