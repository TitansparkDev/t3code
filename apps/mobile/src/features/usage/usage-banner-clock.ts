const MINUTE_MS = 60_000;

export interface UsageBannerMinuteClockOptions {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly initiallyForeground?: boolean;
}

export function createUsageBannerMinuteClock(options: UsageBannerMinuteClockOptions) {
  let snapshot = options.now();
  let foreground = options.initiallyForeground ?? true;
  let timer: unknown = null;
  const visibleClients = new Set<string>();
  const listeners = new Set<() => void>();

  const publishNow = () => {
    const next = options.now();
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const stop = () => {
    if (timer === null) return;
    options.clearInterval(timer);
    timer = null;
  };

  const reconcile = () => {
    if (!foreground || visibleClients.size === 0) {
      stop();
      return;
    }
    publishNow();
    if (timer !== null) return;
    timer = options.setInterval(publishNow, MINUTE_MS);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible(clientId: string, visible: boolean) {
      if (visible) visibleClients.add(clientId);
      else visibleClients.delete(clientId);
      reconcile();
    },
    remove(clientId: string) {
      visibleClients.delete(clientId);
      reconcile();
    },
    setForeground(next: boolean) {
      foreground = next;
      reconcile();
    },
    refresh() {
      if (foreground && visibleClients.size > 0) publishNow();
    },
  };
}

export const usageBannerMinuteClock = createUsageBannerMinuteClock({
  now: Date.now,
  initiallyForeground: false,
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
});
