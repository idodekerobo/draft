# Draft landing page

The landing page is the public Next.js marketing site for Draft. It explains the company-brain product and introduces MCP and CLI agent access. It does not contain the authenticated workspace or the Draft API.

MIT licensed orb animation: https://github.com/usespaceui/ui/tree/main/src/registry/components/orb

## Local development

From the repository root:

~~~bash
make run-local
~~~

Or run it alone. The landing page installs outside the repo workspaces:

~~~bash
cd apps/landing-page
npm install --workspaces=false
bun run dev -- --port 3001
~~~

Required local link configuration:

~~~env
NEXT_PUBLIC_APP_URL=http://localhost:3000
DRAFT_API_BASE_URL=http://localhost:8787
PORT=3001
~~~

Optional public analytics and support configuration:

~~~env
NEXT_PUBLIC_CRISP_WEBSITE_ID=
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=
NEXT_PUBLIC_META_PIXEL_ID=
~~~

The Crisp history route also uses server-side CRISP_HISTORY_SECRET, CRISP_API_IDENTIFIER, and CRISP_API_KEY. Do not share those values with the web app or desktop app.

To change the theme from the browser console:

~~~js
window.dispatchEvent(new CustomEvent("draft:theme", { detail: { theme: "dark" } }));
~~~

Use `"light"` for light mode, or omit `detail` to toggle.

## Build

~~~bash
cd apps/landing-page
bun run build
bun run start
~~~

The hosted site runs at [draftai.us](https://draftai.us). A self-hosted deployment may serve this app separately or use another public signup/documentation site; the authenticated web app and API are configured independently.
