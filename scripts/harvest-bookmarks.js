// Paste into the browser console on x.com/i/bookmarks (or run via an agent
// driving your own logged-in Chrome). Collects PUBLIC post IDs from the DOM.
//
// It never reads cookies, tokens or the session. IDs only.
//
// Key finding: X ignores programmatic scrolling. window.scrollTo moves the page
// but the virtualized list does not re-render and the feed does not load more.
// Only real wheel events work, so scroll by hand (or with real input events)
// and call __harvest() as you go.

window.__ids = window.__ids || new Set();

window.__harvest = () => {
  document.querySelectorAll('a[href*="/status/"]').forEach((a) => {
    const m = a.getAttribute("href").match(/\/status\/(\d+)/);
    if (m) window.__ids.add(m[1]);
  });
  return window.__ids.size;
};

// Dump in chunks: console output gets truncated on large arrays.
window.__dump = (i) => [...window.__ids].slice(i * 40, (i + 1) * 40).join(",");

window.__stat = () =>
  JSON.stringify({
    n: window.__ids.size,
    y: Math.round(window.scrollY),
    h: document.documentElement.scrollHeight,
    last: [...document.querySelectorAll("time")].map((t) => t.getAttribute("datetime")).pop(),
    spinner: !!document.querySelector('[role="progressbar"]'),
  });

// End of feed = spinner gone AND count unchanged for 5 consecutive cycles.
// Anything less and you will stop early, thinking you got everything.
