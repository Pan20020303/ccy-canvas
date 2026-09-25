import type { AssistantRuntime, ThreadListState } from "@assistant-ui/react";

/**
 * @assistant-ui/core 0.2.20–0.2.23 creates a new thread-list snapshot on every read,
 * even when subscribed. The store bridge expects Object.is-stable snapshots:
 * otherwise its update loop fails and ThreadPrimitive.Messages stays empty.
 *
 * Cache only equal top-level snapshots, not messages or subscription events.
 * Keep this compatibility boundary local to our runtime, without modifying
 * the library instance/prototypes. The real-provider render tests cover it.
 */
export function withStableThreadListSnapshot(runtime: AssistantRuntime): AssistantRuntime {
  let previous: ThreadListState | undefined;
  const getState = () => {
    const next = runtime.threads.getState();
    const keys = Object.keys(next) as (keyof ThreadListState)[];
    if (!previous || keys.length !== Object.keys(previous).length ||
      keys.some((key) => !Object.is(previous![key], next[key]))) {
      previous = next;
    }
    return previous;
  };
  const threads = new Proxy(runtime.threads, {
    get(target, key, receiver) {
      return key === "getState" ? getState : Reflect.get(target, key, receiver);
    },
  });
  return new Proxy(runtime, {
    get(target, key, receiver) {
      return key === "threads" ? threads : Reflect.get(target, key, receiver);
    },
  });
}
