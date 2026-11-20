const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLES = `
:root{color-scheme:light dark;--bg:#FAF8F5;--surface:#FFFDFA;--text:#292521;--muted:#6E675F;--border:#E4DED6;--action:#A94312;--action-label:#FFFDFA;--link:#A94312;--ok:#2F6B3F;--err:#A12B1F}
@media (prefers-color-scheme:dark){:root{--bg:#211F1D;--surface:#322E2A;--text:#F3EFE9;--muted:#B5ACA2;--border:#433D36;--action:#F3EFE9;--action-label:#292521;--link:#FF914D;--ok:#7DCB8F;--err:#FF8A7A}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.bar{height:4px;background:linear-gradient(90deg,#FFDE59,#FF914D)}
.body{padding:28px 28px 24px}
.brand{margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted)}
h1{margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:650}
h2{margin:20px 0 4px;font-size:13px;font-weight:600;color:var(--muted)}
p{margin:0;color:var(--muted);font-size:14px}
.status{display:inline-block;margin-bottom:12px;font-size:13px;font-weight:600}
.status.ok{color:var(--ok)}.status.err{color:var(--err)}
button{margin-top:24px;width:100%;padding:10px 14px;border:0;border-radius:8px;background:var(--action);color:var(--action-label);font:inherit;font-weight:600;cursor:pointer;transition:transform 120ms cubic-bezier(.23,1,.32,1)}
button:active{transform:scale(.98)}
button:focus-visible{outline:2px solid var(--link);outline-offset:2px}
@media (prefers-reduced-motion:reduce){button{transition:none}}
`;

export interface OAuthResultPage {
  kind: "success" | "error";
  heading: string;
  message: string;
  // Shown under the message as a second, smaller heading and paragraph.
  next?: { heading: string; message: string };
}

export function oauthResultResponse(page: OAuthResultPage, status = 200): Response {
  const next = page.next
    ? `<h2>${escapeHtml(page.next.heading)}</h2><p>${escapeHtml(page.next.message)}</p>`
    : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.heading)} · Draft</title><style>${STYLES}</style></head><body><main><div class="bar"></div><div class="body"><p class="brand">Draft</p><span class="status ${page.kind === "success" ? "ok" : "err"}">${page.kind === "success" ? "Connected" : "Not connected"}</span><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.message)}</p>${next}<button type="button" id="close">Close this tab</button><p id="hint" hidden style="margin-top:12px;font-size:13px">Your browser kept this tab open. Close it yourself and return to Draft.</p></div></main><script>document.getElementById("close").addEventListener("click",function(){window.close();setTimeout(function(){document.getElementById("hint").hidden=false},200)})</script></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
