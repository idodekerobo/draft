import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolList } from "./ToolList";

test("Connections renders a visible associated search label on both platforms", () => {
  for (const platform of ["web", "desktop"] as const) {
    const html = renderToStaticMarkup(<ToolList platform={platform} statuses={{}} agentPrompt="setup" agentLastUsedAt={null} mcpUrl="http://localhost/mcp" panels={{}} searchable />);
    expect(html).toMatch(/<label class="ui-tool-list__search-title" for="([^"]+)">Search connections<\/label>/);
    const id = html.match(/<label class="ui-tool-list__search-title" for="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${id}" class="ui-input ui-tool-list__search" type="search"`);
    expect(html).not.toContain('ui-visually-hidden">Search connections');
  }
});
