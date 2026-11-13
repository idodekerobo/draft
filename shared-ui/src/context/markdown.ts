import { Marked } from "marked";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

// Context text comes from Slack, meetings and other people's input, so raw
// HTML is escaped and only http(s)/mailto links render. Images render as alt text.
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!isSafeHref(href)) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/** The source of each top-level block. Joined, they give back the input exactly, CRLF included. */
export function markdownBlocks(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const raws: string[] = [];
  let leading = "";
  for (const token of marked.lexer(normalized)) {
    if (token.type !== "space") {
      raws.push(leading + token.raw);
      leading = "";
    } else if (raws.length > 0) {
      raws[raws.length - 1] += token.raw;
    } else {
      leading += token.raw;
    }
  }
  if (leading) raws.push(leading);

  const blocks: string[] = [];
  let at = 0;
  for (const raw of raws) {
    let end = at;
    for (let i = 0; i < raw.length; i++) end += markdown.startsWith("\r\n", end) ? 2 : 1;
    blocks.push(markdown.slice(at, end));
    at = end;
  }
  return blocks;
}
