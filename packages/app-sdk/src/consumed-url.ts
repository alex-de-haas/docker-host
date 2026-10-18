/** Remove consumed launch parameters immediately, then synchronize routers installed by parent effects. */
export function replaceConsumedUrl(url: URL): void {
  const browser = window;
  const route = `${url.pathname}${url.search}${url.hash}`;
  browser.history.replaceState(null, "", route);
  // Next installs its History API adapter in a parent passive effect, after the SDK's child
  // effects. Repeat the final cleanup once that effect flush ends so its canonical URL also
  // changes. Otherwise HMR restores the original, already-consumed authorization callback.
  // A later cleanup or navigation owns its own URL; never replace it with this older snapshot.
  queueMicrotask(() => {
    if (browser.location.href === url.href) browser.history.replaceState(browser.history.state, "", route);
  });
}
