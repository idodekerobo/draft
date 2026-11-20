import { createHash } from "node:crypto";
import { capMarkdown, type RenderedContent } from "./render-common";

export interface DriveReply {
  author?: { displayName?: string };
  content?: string;
  createdTime?: string;
  modifiedTime?: string;
  deleted?: boolean;
}

export interface DriveComment extends DriveReply {
  resolved?: boolean;
  quotedFileContent?: { value?: string };
  replies?: DriveReply[];
}

const textOf = (entry: DriveReply) => (entry.deleted ? "(deleted)" : entry.content ?? "");

export function renderComments(comments: DriveComment[]): string {
  if (comments.length === 0) return "";
  const entries = comments.map((comment) => {
    const lines: string[] = [];
    const status = comment.resolved ? " (resolved)" : "";
    if (comment.quotedFileContent?.value) lines.push(`> ${comment.quotedFileContent.value.replace(/\n/g, " ")}`);
    lines.push(`- ${comment.author?.displayName ?? "Unknown"}${status}: ${textOf(comment)}`);
    for (const reply of comment.replies ?? []) {
      lines.push(`  - ${reply.author?.displayName ?? "Unknown"}: ${textOf(reply)}`);
    }
    return lines.join("\n");
  });
  return `## Comments\n\n${entries.join("\n\n")}`;
}

// A new, edited, resolved or deleted comment or reply changes the hash, so it becomes a new item version.
export function commentsHash(comments: DriveComment[]): string {
  if (comments.length === 0) return "";
  const digest = comments.map((comment) => [
    comment.content,
    comment.resolved,
    comment.deleted ?? false,
    (comment.replies ?? []).map((reply) => [reply.content, reply.createdTime, reply.deleted ?? false]),
  ]);
  return createHash("sha256").update(JSON.stringify(digest)).digest("hex").slice(0, 12);
}

export function withComments(rendered: RenderedContent, comments: DriveComment[]): RenderedContent {
  if (comments.length === 0) return rendered;
  const capped = capMarkdown(`${rendered.markdown}\n\n${renderComments(comments)}`);
  const structured =
    rendered.structured && typeof rendered.structured === "object"
      ? { ...(rendered.structured as Record<string, unknown>), comments }
      : { content: rendered.structured, comments };
  return { markdown: capped.markdown, structured, truncated: rendered.truncated || capped.truncated };
}
