// utils/skill-frontmatter.ts — read name and description from a skill's leading YAML block

export type SkillFrontmatter = { ok: true; name?: string; description?: string } | { ok: false };

/** Reads a leading `---\n...\n---` YAML block, if any. Malformed YAML is a failure, not a no-op. */
// js-yaml is loaded here, not at startup: Bun caches a module that large under HOME, and most commands never read YAML.
export async function readSkillFrontmatter(content: string): Promise<SkillFrontmatter> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { ok: true };

  let parsed: unknown;
  try {
    parsed = (await import("js-yaml")).default.load(match[1]!);
  } catch {
    return { ok: false };
  }
  if (parsed === null || parsed === undefined) return { ok: true };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };

  const body = parsed as Record<string, unknown>;
  return {
    ok: true,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
  };
}
