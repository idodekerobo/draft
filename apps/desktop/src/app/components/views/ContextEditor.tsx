// ContextEditor.tsx — read-only renderer for a single context file.
//
// Context is canonical in the cloud backend (Postgres); the desktop app only
// reads it (see getContextFiles in desktop/src/index.ts). No write path back
// to the backend exists yet, so editing is disabled here.

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

interface ContextEditorProps {
  relativePath: string;
  initialContent: string;
}

export function ContextEditor({ relativePath, initialContent }: ContextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
    ],
    content: initialContent,
    editable: false,
  }, [relativePath]);

  return (
    <EditorContent editor={editor} className="context-content__markdown context-content__editor" />
  );
}

// ── RawEditor — plain-text read-only view over the full file (frontmatter included) ──

interface RawEditorProps {
  relativePath: string;
  initialRawContent: string;
}

export function RawEditor({ relativePath, initialRawContent }: RawEditorProps) {
  return (
    <pre key={relativePath} className="context-content__raw-editor" spellCheck={false}>
      {initialRawContent}
    </pre>
  );
}
