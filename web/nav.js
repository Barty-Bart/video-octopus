// Page navigation, one page at a time. `open(nav)` loads the page for the current hash and returns it ({ teardown })
// or null. A newer navigation aborts the one still loading (nav.signal, nav.alive() turns false, so the page can skip
// work and stop polling early), waits for it to finish, then tears it down before the next page loads. So every page
// that loaded is torn down, even one left during its first load, and a slow page can't draw over the next one.
export function makeRouter(open, { onError = (e) => console.error(e) } = {}) {
  let current = null, chain = Promise.resolve(), ctl = null;
  return function navigate() {
    ctl?.abort();
    const mine = ctl = new AbortController();
    chain = chain.then(async () => {
      current?.teardown?.();
      current = null;
      if (mine.signal.aborted) return; // an even newer navigation is queued: this page needn't load at all
      current = (await open({ signal: mine.signal, alive: () => !mine.signal.aborted })) || null;
    }).catch(onError);
    return chain;
  };
}
