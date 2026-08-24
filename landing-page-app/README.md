# Draft landing page

The landing page is the public Next.js marketing site for Draft. It explains the company-brain product and links users to hosted signup, downloads, support, and the open-source repository. It does not contain the authenticated workspace or the Draft API.

## Local development

From the repository root:

~~~bash
make run-local
~~~

Or run it alone:

~~~bash
cd landing-page-app
bun run dev -- --port 3001
~~~

Required local link configuration:

~~~env
NEXT_PUBLIC_APP_URL=http://localhost:3000
PORT=3001
~~~

Optional public analytics and support configuration:

~~~env
NEXT_PUBLIC_CRISP_WEBSITE_ID=
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=
~~~

The Crisp history route also uses server-side CRISP_HISTORY_SECRET, CRISP_API_IDENTIFIER, and CRISP_API_KEY. Do not share those values with the web app or desktop app.

## Build

~~~bash
cd landing-page-app
bun run build
bun run start
~~~

The hosted site runs at [draftai.us](https://draftai.us). A self-hosted deployment may serve this app separately or use another public signup/documentation site; the authenticated web app and API are configured independently.
