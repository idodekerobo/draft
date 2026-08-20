// Ported near-verbatim from flooently-brain/backend/src/ingest/claude-code.ts
// (proven in production against real Claude Code transcripts).

export interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ParsedTranscript {
  messages: ParsedMessage[];
  startedAt: string | null;
  endedAt: string | null;
}

interface ClaudeCodeContentBlock {
  type: string;
  text?: string;
}

interface ClaudeCodeLine {
  type: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role: string;
    content: string | ClaudeCodeContentBlock[];
  };
}

function textFromContent(content: string | ClaudeCodeContentBlock[]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!.trim())
    .join("\n")
    .trim();
}

export function parseClaudeCodeJsonl(raw: string): ParsedTranscript {
  const messages: ParsedMessage[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const line of raw.split("\n").filter(Boolean)) {
    let parsed: ClaudeCodeLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed.timestamp === "string") {
      startedAt ??= parsed.timestamp;
      endedAt = parsed.timestamp;
    }

    if (parsed.isSidechain) continue;
    const message = parsed.message;
    if (!message) continue;

    if (parsed.type === "user" && message.role === "user") {
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "user", content: text });
    }

    if (parsed.type === "assistant" && message.role === "assistant") {
      const text = Array.isArray(message.content) ? textFromContent(message.content) : "";
      if (text) messages.push({ role: "assistant", content: text });
    }
  }

  return { messages, startedAt, endedAt };
}
