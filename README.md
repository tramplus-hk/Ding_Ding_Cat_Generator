# Sticker Generation Platform

Internal sticker generation platform built with Vite, React, TypeScript, and an Express backend. The goal is to let internal users submit sticker prompts, generate sticker assets with Nano Banana 2, review the result, and upload only accepted final JSON records to Notion.

This repository is currently a skeleton. It contains the app structure, shared schemas, placeholder routes, and service boundaries, but it does not yet implement real file persistence, Nano Banana 2 calls, or Notion writes.

## Architecture

```txt
apps/web
  Vite React frontend
  Prompt form, history page, sticker review page

apps/server
  Express TypeScript backend
  API routes, local cache boundary, Nano Banana 2 boundary, Notion boundary

packages/shared
  Shared Zod schemas and TypeScript types

data
  Local working folders for baseline material, generated assets, and cached JSON
```

## Product Flow

1. User submits a sticker request from the web app.
2. Server creates a local JSON cache record.
3. Server sends the prompt data to Nano Banana 2.
4. Generated SVG or GIF output is saved locally.
5. User reviews the generated sticker in the web app.
6. If rejected, the record remains local for retry/debugging.
7. If accepted, the final JSON is uploaded to Notion.
8. After Notion confirms success, the local JSON cache is removed.

## Tech Stack

- Vite
- React
- TypeScript
- React Router
- Express
- Zod
- npm workspaces

## Repository Structure

```txt
.
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── routes/
│   │       └── services/
│   └── web/
│       └── src/
│           ├── pages/
│           └── styles.css
├── data/
│   ├── baseline/
│   ├── generated/
│   └── history/
├── packages/
│   └── shared/
│       └── src/
├── .env.example
├── package.json
└── tsconfig.base.json
```

## Data Model

Sticker requests use the shared schema in `packages/shared/src/sticker.ts`.

```ts
type StickerRecord = {
  id: string;
  type: "svg" | "gif";
  theme: string;
  category: string;
  stickerContent: string;
  description: string;
  status:
    | "pending"
    | "generating"
    | "generated"
    | "rejected"
    | "failed"
    | "accepted"
    | "uploading"
    | "uploaded"
    | "upload_failed";
  result?: {
    provider: "nano-banana-2";
    format: "svg" | "gif";
    localPath?: string;
    notionPageId?: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
};
```

## Local Data Layout

The intended local storage layout is:

```txt
data/
  baseline/
    <category>/
      <sticker-content>/
  generated/
    <category>/
      <sticker-content>/
        result.svg
        result.gif
  history/
    <category>/
      <sticker-content>/
        request.json
```

For the current skeleton, `apps/server/src/services/stickerStorage.ts` uses an in-memory placeholder cache. File-backed JSON persistence is the next implementation step.

## Environment

Copy `.env.example` to `.env` when real integrations are added.

```env
SERVER_PORT=4000
WEB_ORIGIN=http://localhost:5173

NANO_BANANA_API_KEY=
NANO_BANANA_API_URL=

NOTION_TOKEN=
NOTION_DATABASE_ID=
```

The frontend proxies `/api` requests to `http://localhost:4000` through `apps/web/vite.config.ts`.

## Setup

Install dependencies:

```bash
npm install
```

Start the web app and server:

```bash
npm run dev
```

Start only the frontend:

```bash
npm run dev:web
```

Start only the backend:

```bash
npm run dev:server
```

Default local URLs:

- Web: `http://localhost:5173`
- Server health check: `http://localhost:4000/api/health`

## Scripts

```bash
npm run dev
npm run dev:web
npm run dev:server
npm run typecheck
npm run build
```

## API Skeleton

The backend currently exposes placeholder sticker routes under `/api/stickers`.

```txt
GET    /api/health
GET    /api/stickers
POST   /api/stickers
GET    /api/stickers/:id
POST   /api/stickers/:id/generate
POST   /api/stickers/:id/accept
POST   /api/stickers/:id/reject
```

Current behavior:

- `POST /api/stickers` validates input and creates an in-memory placeholder record.
- `POST /api/stickers/:id/generate` returns a placeholder Nano Banana 2 result.
- `POST /api/stickers/:id/accept` returns a placeholder Notion page ID and removes the in-memory cache record.

## Notion Strategy

Notion should receive only accepted final records. Drafts, failed attempts, rejected generations, and temporary cache files should remain local.

Recommended Notion fields:

- `Category`
- `Sticker Content`
- `Type`
- `Theme`
- `Description`
- `Status`
- `Provider`
- `Local Path` or hosted asset URL
- `Final JSON`
- `Created At`
- `Updated At`

## Cache Cleanup Policy

Local JSON cache should be removed only after Notion confirms a successful upload.

```txt
accept sticker
  -> mark local record as uploading
  -> upload final JSON to Notion
  -> if upload succeeds, remove local JSON cache
  -> if upload fails, keep local JSON and mark upload_failed
```

Generated assets should stay local until Notion or another asset store contains a durable copy or URL.

## Next Steps

1. Replace in-memory cache with file-backed JSON storage under `data/history`.
2. Implement generated asset writes under `data/generated`.
3. Connect `apps/server/src/services/nanoBanana.ts` to the real Nano Banana 2 API.
4. Connect `apps/server/src/services/notion.ts` to the Notion API.
5. Wire the frontend form to `POST /api/stickers`.
6. Add history loading and sticker detail loading from the backend.
7. Add accept/reject UI actions.
8. Add error states and retry handling for failed uploads.

## Current Status

Verified commands:

```bash
npm run typecheck
npm run build
```

Security audit is currently clean:

```bash
npm audit
```
