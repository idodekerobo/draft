import { memo } from "react";
import { markdownBlocks, renderMarkdown } from "../context/markdown";
import { cachedMarkdown } from "./markdown-cache";
import { useRevealedText } from "./useRevealedText";

const Block = memo(function Block({ html }: { html: string }) {
  return <div className="ui-prose__block" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A reply that is still being written. Finished blocks are cached, so only the last block is parsed again. */
export function LiveText({ text }: { text: string }) {
  const shown = useRevealedText(text);
  const blocks = markdownBlocks(shown);
  return (
    <div className="ui-prose">
      {blocks.map((raw, index) => (
        <Block key={index} html={index < blocks.length - 1 ? cachedMarkdown(raw) : renderMarkdown(raw)} />
      ))}
    </div>
  );
}
