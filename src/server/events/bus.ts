import { EventEmitter } from "node:events";

/** Typed envelope every SSE client receives. */
export type AppEvent = {
  id: number;
  type: AppEventType;
  ts: number;
  payload: unknown;
};

export type AppEventType =
  | "hunt.batch.started"
  | "hunt.search.started"
  | "hunt.search.result"
  | "hunt.win"
  | "item.updated"
  | "queue.updated"
  | "budget.updated"
  | "ai.check.started"
  | "ai.check.completed"
  | "fixer.queue.changed"
  | "fixer.analysis.progress"
  | "fixer.analysis.completed"
  | "system.dryrun.changed"
  | "system.status";

const BUFFER_SIZE = 500;

/**
 * In-process event bus feeding the SSE endpoint and the activity log.
 * Keeps a replay buffer so EventSource reconnects (Last-Event-ID) can catch up.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: AppEvent[] = [];
  private nextId = 1;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: AppEventType, payload: unknown): AppEvent {
    const event: AppEvent = { id: this.nextId++, type, ts: Date.now(), payload };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Events with id > lastId still in the buffer (for SSE reconnect). */
  since(lastId: number): AppEvent[] {
    return this.buffer.filter((e) => e.id > lastId);
  }
}
