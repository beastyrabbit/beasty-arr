import { useEffect, useSyncExternalStore } from "react";
import {
  type AnyServerEvent,
  APP_EVENT_TYPES,
  type AppEventEnvelope,
  type AppEventType,
} from "../../shared/api-types.js";

export type SseStatus = "idle" | "connecting" | "live" | "reconnecting" | "down";

type Listener = () => void;
type EventHandler = (event: AnyServerEvent) => void;

const DOWN_AFTER_ERRORS = 3;

/**
 * SSE EventSource singleton. Native EventSource replays Last-Event-ID on
 * reconnect; the server buffers 500 events, so on any reconnect-after-drop we
 * additionally fire `onReconnect` so the query layer can invalidate active
 * queries (covers buffer-gap loss conservatively).
 */
class SseClient {
  private es: EventSource | null = null;
  private status: SseStatus = "idle";
  private errorCount = 0;
  private hadDrop = false;
  private statusListeners = new Set<Listener>();
  private eventHandlers = new Set<EventHandler>();
  private reconnectHandlers = new Set<Listener>();
  private latest = new Map<AppEventType, AnyServerEvent>();
  private latestListeners = new Set<Listener>();

  connect(): void {
    if (this.es) return;
    const es = new EventSource("/api/events");
    this.es = es;
    this.setStatus("connecting");

    es.onopen = () => {
      const reconnected = this.hadDrop;
      this.errorCount = 0;
      this.hadDrop = false;
      this.setStatus("live");
      if (reconnected) for (const h of this.reconnectHandlers) h();
    };
    es.onerror = () => {
      this.errorCount++;
      this.hadDrop = true;
      this.setStatus(this.errorCount >= DOWN_AFTER_ERRORS ? "down" : "reconnecting");
    };
    for (const type of APP_EVENT_TYPES) {
      es.addEventListener(type, (msg) => {
        let event: AnyServerEvent;
        try {
          event = JSON.parse((msg as MessageEvent).data) as AnyServerEvent;
        } catch {
          return;
        }
        this.latest.set(event.type, event);
        for (const l of this.latestListeners) l();
        for (const h of this.eventHandlers) h(event);
      });
    }
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
    this.setStatus("idle");
  }

  private setStatus(status: SseStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l();
  }

  getStatus = (): SseStatus => this.status;

  subscribeStatus = (listener: Listener): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  subscribeLatest = (listener: Listener): (() => void) => {
    this.latestListeners.add(listener);
    return () => this.latestListeners.delete(listener);
  };

  getLatest = <T extends AppEventType>(type: T): AppEventEnvelope<T> | null =>
    (this.latest.get(type) as AppEventEnvelope<T> | undefined) ?? null;

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onReconnect(handler: Listener): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}

export const sse = new SseClient();

export function useSseStatus(): SseStatus {
  return useSyncExternalStore(sse.subscribeStatus, sse.getStatus);
}

/** Latest event of a type (null before the first one arrives). */
export function useLatestEvent<T extends AppEventType>(type: T): AppEventEnvelope<T> | null {
  return useSyncExternalStore(sse.subscribeLatest, () => sse.getLatest(type));
}

/** Imperative per-event subscription (streaming panels, tickers). */
export function useSseEvent<T extends AppEventType>(
  type: T,
  handler: (event: AppEventEnvelope<T>) => void,
): void {
  useEffect(
    () =>
      sse.onEvent((event) => {
        if (event.type === type) handler(event as AppEventEnvelope<T>);
      }),
    // Callers pass inline handlers; re-subscribing per render is harmless here.
    [type, handler],
  );
}
