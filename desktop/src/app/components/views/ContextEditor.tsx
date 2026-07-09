// ContextEditor.tsx — WYSIWYG editor for a single context file (Tiptap)
//
// Write path (two tiers, sequential — never independent timers, see plans/0025):
//   1. Frequent tier: ~2s debounced autosave straight to the file on disk (saveContextFile).
//   2. Infrequent tier: on blur or file-switch (this component unmounting), flush any
//      pending save, then record a history.db checkpoint (checkpointContextFile) from
//      whatever is now durable on disk — never from in-memory editor state.
//
// Known limitation: a hard app-close/quit is not guaranteed to flush the final
// checkpoint (no main-process beforeExit hook wired up yet) — blur/file-switch and
// the ~2s autosave bound the amount of unrecorded edit time in that case.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { rpc } from "../../rpc";

// Mirrors splitFrontmatter in desktop/src/index.ts (getContextFiles) — kept in
// sync there because the raw editor round-trips full file text through the same
// frontmatterRaw/body split the main process uses to build ContextFileEntry.
function splitFrontmatter(content: string): { frontmatterRaw: string; body: string } {
  if (!content.startsWith("---")) return { frontmatterRaw: "", body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatterRaw: "", body: content };
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatterRaw: content.slice(0, content.length - body.length), body };
}

// tiptap-markdown's storage augmentation doesn't resolve through this project's
// moduleResolution setup, so read it via a narrow local cast instead.
interface MarkdownEditorStorage {
  markdown: { getMarkdown(): string };
}

const AUTOSAVE_DEBOUNCE_MS = 2000;

type SaveStatus = "idle" | "saving" | "saved";

export interface EditorHandle {
  flushAndCheckpoint: () => Promise<void>;
}

interface ContextEditorProps {
  relativePath: string;
  initialContent: string;
  frontmatterRaw: string;
  onSaveStatusChange: (status: SaveStatus) => void;
  onSaved: (relativePath: string, content: string) => void;
}

export const ContextEditor = forwardRef<EditorHandle, ContextEditorProps>(function ContextEditor({ relativePath, initialContent, frontmatterRaw, onSaveStatusChange, onSaved }, ref) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestMarkdownRef = useRef(initialContent);
  const dirtyRef = useRef(false);
  // Tracks the markdown we know is durable on disk, so a transaction that changes
  // the doc without changing its content (e.g. gapcursor/dropcursor inserting a
  // trailing paragraph so the cursor has somewhere to land on click) doesn't get
  // mistaken for a real edit and trigger a save.
  const lastSavedMarkdownRef = useRef(initialContent);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
    ],
    content: initialContent,
    onUpdate: ({ editor }) => {
      const newMarkdown = (editor.storage as unknown as MarkdownEditorStorage).markdown.getMarkdown();
      if (newMarkdown === lastSavedMarkdownRef.current) {
        // Doc changed (ProseMirror transaction) but the serialized content didn't — not a real edit.
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        dirtyRef.current = false;
        onSaveStatusChange("idle");
        return;
      }
      dirtyRef.current = true;
      onSaveStatusChange("saving");
      if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current);
      latestMarkdownRef.current = newMarkdown;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void doSave();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    onBlur: () => {
      void flushAndCheckpoint();
    },
  });

  async function doSave(): Promise<void> {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const markdown = latestMarkdownRef.current;
    const content = frontmatterRaw + markdown;
    await rpc.request.saveContextFile({ relativePath, content });
    lastSavedMarkdownRef.current = markdown;
    onSaved(relativePath, markdown);
    onSaveStatusChange("saved");
    savedFadeTimerRef.current = setTimeout(() => onSaveStatusChange("idle"), 2000);
  }

  async function flushAndCheckpoint(): Promise<void> {
    if (!dirtyRef.current) return;
    await doSave();
    await rpc.request.checkpointContextFile({ relativePath });
    dirtyRef.current = false;
  }

  useImperativeHandle(ref, () => ({ flushAndCheckpoint }));

  // Unmounts on file switch (parent keys this component by relativePath) — this is
  // the other trigger for a checkpoint besides blur, per the two-tier write path above.
  useEffect(() => {
    return () => {
      void flushAndCheckpoint();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath]);

  return (
    <EditorContent editor={editor} className="context-content__markdown context-content__editor" />
  );
});

// ── RawEditor — plain-text editor over the full file (frontmatter included) ────
// Same two-tier write path as ContextEditor above, but there's no markdown/frontmatter
// split to reconstruct on save: the textarea's value is already the exact file text.

interface RawEditorProps {
  relativePath: string;
  initialRawContent: string;
  onSaveStatusChange: (status: SaveStatus) => void;
  onSaved: (relativePath: string, content: string, frontmatterRaw: string) => void;
}

export const RawEditor = forwardRef<EditorHandle, RawEditorProps>(function RawEditor({ relativePath, initialRawContent, onSaveStatusChange, onSaved }, ref) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRawRef = useRef(initialRawContent);
  const dirtyRef = useRef(false);
  // See ContextEditor's lastSavedMarkdownRef — same guard against non-edit events.
  const lastSavedRawRef = useRef(initialRawContent);
  const [value, setValue] = useState(initialRawContent);

  async function doSave(): Promise<void> {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const raw = latestRawRef.current;
    await rpc.request.saveContextFile({ relativePath, content: raw });
    lastSavedRawRef.current = raw;
    const { frontmatterRaw, body } = splitFrontmatter(raw);
    onSaved(relativePath, body, frontmatterRaw);
    onSaveStatusChange("saved");
    savedFadeTimerRef.current = setTimeout(() => onSaveStatusChange("idle"), 2000);
  }

  async function flushAndCheckpoint(): Promise<void> {
    if (!dirtyRef.current) return;
    await doSave();
    await rpc.request.checkpointContextFile({ relativePath });
    dirtyRef.current = false;
  }

  useImperativeHandle(ref, () => ({ flushAndCheckpoint }));

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    if (next === lastSavedRawRef.current) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      dirtyRef.current = false;
      onSaveStatusChange("idle");
      return;
    }
    latestRawRef.current = next;
    dirtyRef.current = true;
    onSaveStatusChange("saving");
    if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Unmounts on file switch or raw/rendered toggle (parent keys this component
  // by relativePath) — the other trigger for a checkpoint besides blur.
  useEffect(() => {
    return () => {
      void flushAndCheckpoint();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath]);

  return (
    <textarea
      className="context-content__raw-editor"
      value={value}
      onChange={handleChange}
      onBlur={() => void flushAndCheckpoint()}
      spellCheck={false}
    />
  );
});
