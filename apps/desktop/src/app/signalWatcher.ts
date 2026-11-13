type Listener = (event: string, payload?: unknown) => void;

interface Deps {
  setTopics: (topics: string[]) => unknown;
  onSignal: (handler: (topic: string, event: string, payload?: unknown) => void) => () => void;
  onConnection: (handler: (connected: boolean) => void) => () => void;
}

/**
 * The window side of the signals. It keeps the listeners per topic, tells main the whole list of topics whenever
 * that list changes (batched, so a screen that mounts several watchers sends one message), and passes
 * each signal from main to the listeners of its topic. A new page sends an empty list first, which drops
 * what main still holds for the page before it.
 */
export function createWindowSignalWatcher({ setTopics, onSignal, onConnection }: Deps) {
  const listeners = new Map<string, Set<Listener>>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  // Main tells the page the state after each list, so until then it assumes the connection is fine.
  let connected = true;
  let scheduled = false;

  const send = () => {
    scheduled = false;
    const topics = [...listeners.keys()];
    void Promise.resolve()
      .then(() => setTopics(topics))
      .catch(() => {
        // Main asks again at the next change; the safety polls cover the gap.
      });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(send);
  };

  onSignal((topic, event, payload) => listeners.get(topic)?.forEach((listener) => listener(event, payload)));
  onConnection((next) => {
    connected = next;
    connectionListeners.forEach((listener) => listener(next));
  });
  send();

  function watchConnection(onChange: (connected: boolean) => void): () => void {
    connectionListeners.add(onChange);
    onChange(connected);
    return () => void connectionListeners.delete(onChange);
  }

  function watch(topic: string, listener: Listener): () => void {
    const set = listeners.get(topic) ?? new Set<Listener>();
    const isNew = !listeners.has(topic);
    set.add(listener);
    listeners.set(topic, set);
    if (isNew) schedule();
    return () => {
      set.delete(listener);
      if (set.size > 0) return;
      listeners.delete(topic);
      schedule();
    };
  };

  return { watch, watchConnection };
}
