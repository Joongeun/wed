// Lazy Playwright Chromium. Screenshots and the inspiration board use it.
// playwright-core is optional: every caller must handle a null browser.

let chromiumMod = null;
let shared = null; // Promise<Browser|null> while launching or launched
let closing = false;

export async function loadChromium() {
  if (chromiumMod !== null) return chromiumMod || null;
  try {
    chromiumMod = (await import('playwright-core')).chromium;
  } catch {
    chromiumMod = false;
  }
  return chromiumMod || null;
}

export async function launch(opts = {}) {
  const chromium = await loadChromium();
  if (!chromium) return null;
  try {
    return await chromium.launch(opts);
  } catch (e) {
    process.stderr.write(`wed: could not launch Chromium (${e.message.split('\n')[0]}). Run: npx playwright-core install chromium\n`);
    return null;
  }
}

/** One headless browser reused for the life of the server. */
export async function sharedBrowser() {
  if (closing) return null;
  if (shared) {
    const b = await shared;
    if (b && b.isConnected()) return b;
  }
  shared = launch({ headless: true });
  return shared;
}

/** Waits for an in-flight launch too, so no Chromium process outlives the server. */
export async function closeShared() {
  closing = true;
  const p = shared;
  shared = null;
  if (p) {
    const b = await p;
    if (b) await b.close().catch(() => {});
  }
  closing = false;
}
