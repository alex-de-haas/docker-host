// jsdom does not supply ResizeObserver. Radix form controls observe their hidden native inputs;
// layout-sensitive tests replace this inert observer with their own measured callback.
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
