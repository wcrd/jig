// Modal dialogs as components: each is mounted on the page while it's open
// and calls `done` with its result when it closes.

import { type Component, mount, unmount } from "svelte";

/** Shows `component` until it calls `done`; resolves to the value it passes. */
export function openDialog<Props extends Record<string, unknown>, T>(
  component: Component<Props & { done: (value: T) => void }>,
  props: Props,
): Promise<T> {
  return new Promise((resolve) => {
    const done = (value: T) => {
      // Let the closing event finish before the dialog goes.
      queueMicrotask(() => unmount(instance));
      resolve(value);
    };
    const instance = mount(component, { target: document.body, props: { ...props, done } as Props & { done: (value: T) => void } });
  });
}
