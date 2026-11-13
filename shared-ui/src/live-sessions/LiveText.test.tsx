import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { markdownBlocks } from "../context/markdown";
import { LiveText } from "./LiveText";

afterEach(cleanup);

const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

const article = "# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n";

const blockNodes = (container: HTMLElement) => Array.from(container.querySelectorAll(".ui-prose__block"));

describe("LiveText", () => {
  it("renders one block element per Markdown block", () => {
    const { container } = render(<LiveText text={article} />);
    expect(blockNodes(container).length).toBe(markdownBlocks(article).length);
    expect(blockNodes(container).length).toBe(5);
  });

  it("renders an empty preview for empty text", () => {
    const { container } = render(<LiveText text={""} />);
    expect(container.querySelector(".ui-prose")?.children.length).toBe(0);
  });

  it("keeps the DOM of finished blocks when more text arrives in the last block", () => {
    const view = render(<LiveText text={"# Plan\n\nFirst paragraph.\n\nSecond"} />);
    const before = blockNodes(view.container);
    view.rerender(<LiveText text={"# Plan\n\nFirst paragraph.\n\nSecond paragraph, extended."} />);
    const after = blockNodes(view.container);
    expect(after.length).toBe(before.length);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2].textContent).toContain("extended.");
  });
});

describe("LiveText with an unclosed code block", () => {
  const open = "Intro text.\n\n```ts\nconst a = 1;\nconst b = 2;";
  const closed = `${open}\n\`\`\``;

  it("renders the open code as one pre and no paragraph", () => {
    const { container } = render(<LiveText text={open} />);
    const pres = container.querySelectorAll("pre");
    expect(pres.length).toBe(1);
    expect(pres[0].textContent).toContain("const a = 1;");
    expect(pres[0].textContent).toContain("const b = 2;");
    expect(Array.from(container.querySelectorAll("p")).some((p) => p.textContent?.includes("const"))).toBe(false);
  });

  it("renders the blocks before the code the same with and without the closing fence", () => {
    const openView = render(<LiveText text={open} />);
    const openIntro = blockNodes(openView.container)[0].innerHTML;
    openView.unmount();
    const closedView = render(<LiveText text={closed} />);
    expect(blockNodes(closedView.container)[0].innerHTML).toBe(openIntro);
  });
});
