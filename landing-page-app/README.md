This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3001](http://localhost:3001) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Local development / self-hosting

The recommended repository-wide entrypoint is:

```bash
make run-local
```

It starts this app at `http://localhost:3001` and maps the root `.env.local`
values to the landing-page settings that Next.js expects.

For standalone development:

```bash
cd landing-page-app
bun run dev -- --port 3001
```

Standalone development uses `landing-page-app/.env.local` when that file is
present. The repository-wide launcher uses the root `.env.local` instead.

### Required for local links

```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
PORT=3001
```

### Optional integrations and links

```env
NEXT_PUBLIC_CRISP_WEBSITE_ID=
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=
CRISP_HISTORY_SECRET=
CRISP_API_IDENTIFIER=
CRISP_API_KEY=
```

The `CRISP_*` values are server-side credentials for the Crisp history route;
they must not be shared with the web app or desktop app.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
