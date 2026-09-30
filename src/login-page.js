// The sign-in page shown when someone adds the connector in Claude.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Security headers for pages we render: no framing (clickjacking), no scripts.
export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f4; --card:#fff; --text:#1c1f1a; --muted:#5d645a; --line:#d9ddd4;
          --accent:#2f6b3a; --accent-text:#fff; --error-bg:#fdecea; --error:#8a1c14; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141712; --card:#1d211b; --text:#eef1ea; --muted:#a3ab9f; --line:#343a31;
            --accent:#5fa36b; --accent-text:#0d130e; --error-bg:#3a1714; --error:#ffb4ab; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px;
         background:var(--bg); color:var(--text); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 24px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); font-size:15px; }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; font:inherit; padding:12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--text); }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:20px; padding:13px; font:inherit; font-weight:600; border:0; border-radius:8px;
           background:var(--accent); color:var(--accent-text); cursor:pointer; }
  .error { background:var(--error-bg); color:var(--error); border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:8px; }
  .fine { font-size:13px; margin:18px 0 0; }
  code { font-size:13px; word-break:break-all; }
`;

export function loginPage({ clientName, fields, error, username }) {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect TheGrint</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Connect TheGrint</h1>
    <p>Sign in with your TheGrint account so ${esc(clientName || "Claude")} can answer questions about your rounds.</p>
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
    <form method="post" action="/login">
      ${hidden}
      <label for="username">TheGrint username or email</label>
      <input id="username" name="username" autocomplete="username" required value="${esc(username)}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    <p class="fine">Unofficial, not affiliated with TheGrint. Your password is sent to TheGrint once to sign in and is never stored.
      Access is read-only and lasts up to 90 days.</p>
  </main>
</body>
</html>`;
}

export function landingPage(mcpUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TheGrint for Claude</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>TheGrint for Claude</h1>
    <p>Ask Claude questions about your golf rounds, like "how many times have I parred hole 3 at my home course?"</p>
    <p>In Claude, open Settings → Connectors → Add custom connector, and paste this URL:</p>
    <p><code>${esc(mcpUrl)}</code></p>
    <p>Claude will then ask you to sign in with your TheGrint account. It works in the Claude mobile app too.</p>
    <p class="fine">Unofficial, not affiliated with TheGrint.</p>
  </main>
</body>
</html>`;
}
