# Sticker Generation Platform

Internal sticker generation platform built with Vite, React, TypeScript, and an Express backend. The goal is to let internal users submit sticker prompts, generate sticker assets with Nano Banana 2, review the result, and upload only accepted final JSON records to Notion.

This repository currently implements the local workflow foundation. It contains app structure, shared schemas, file-backed local JSON cache, Express-side Nano Banana 2 generation, placeholder fallback asset storage, a placeholder Notion service boundary, and a basic review UI. It does not yet implement real Notion writes.

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
2. Server keeps the draft request in memory.
3. Server generates five runtime-only candidate stickers for the first trial.
4. User selects the most suitable candidate in the web app.
5. If none are suitable, user regenerates five new candidates.
6. If one is close, user can provide a fine-tune requirement; the selected image and prompt are sent back to Nano Banana 2 for five refined candidates.
7. When accepted, the selected image is copied to the final theme folder and the JSON cache is written with the final file URL.
8. The final JSON is uploaded to Notion.
9. The accepted JSON and final image remain under `data/`.

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
  format: "svg" | "gif";
  theme: string;
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
    fileUrl?: string;
    selectedPath?: string;
    candidates?: string[];
    refinementRequirement?: string;
    notionPageId?: string;
  };
  cachePath?: string;
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
    <theme_key>/
      <motion_name>/
  generated/
    <theme_key>/
      <motion_name>.png
      <motion_name>_1.png
      <motion_name>_2.png
  history/
    <theme_key>/
      <motion_name>.json

.runtime/
  generated/
    <theme_key>/
      <motion_name>/
        trial-<timestamp>/
          candidate-01.png
          candidate-02.png
          candidate-03.png
          candidate-04.png
          candidate-05.png
```

Draft records stay in server memory while the user is generating, regenerating, and refining. `apps/server/src/services/stickerStorage.ts` writes JSON to this layout only after the user accepts a selected candidate. The folder and file names are snake_case values derived from `theme` and `description`; the saved JSON keeps the main request attributes as `format`, `theme`, and `description`.

Generated assets are saved under:

```txt
data/generated/
  <theme_key>/
    <motion_name>.png
    <motion_name>_1.png
    <motion_name>_2.png
```

Trial candidates are stored outside `data/` under `.runtime/generated` while the user is deciding. Only the accepted image is copied into `data/generated`.

When `NANO_BANANA_API_KEY` or `AI_GATEWAY_API_KEY` is configured, the Express backend calls the OpenAI-compatible Nano Banana endpoint and saves the accepted image as `<motion_name>.png`. If that motion filename already exists for the theme, it appends `_1`, `_2`, and so on. Without credentials, it writes local placeholder files so the workflow remains usable.

Nano Banana receives image references from:

- `data/baseline/**`: original mascot/reference material.
- `data/generated/<theme_key>/**`: previous generated stickers for the same theme.

The server currently sends up to 8 baseline images and up to 8 same-theme generated images, newest first. Supported reference formats are `png`, `jpg`, `jpeg`, and `webp`.

## Environment

Copy `.env.example` to `.env` when real integrations are added.

```env
SERVER_PORT=4000
WEB_ORIGIN=http://localhost:5173
VITE_API_BASE_URL=

NANO_BANANA_API_KEY=
NANO_BANANA_API_URL=https://ai-gateway.vercel.sh/v1
NANO_BANANA_MODEL=google/gemini-3.1-flash-image-preview
AI_GATEWAY_API_KEY=

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
- API server root: `http://localhost:4000`
- Generated files: `http://localhost:4000/generated/...`

Open `http://localhost:5173` in the browser for the web UI. Port `4000` is the API server only.

## Scripts

```bash
npm run dev
npm run dev:web
npm run dev:server
npm run typecheck
npm run test
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
POST   /api/stickers/:id/refine
POST   /api/stickers/:id/accept
POST   /api/stickers/:id/reject
```

Current behavior:

- `POST /api/stickers` validates input and creates an in-memory draft record.
- `POST /api/stickers/:id/generate` creates five runtime-only candidates and updates the draft record with `result.candidates`.
- `POST /api/stickers/:id/refine` sends the selected candidate and fine-tune requirement back to Nano Banana 2, then returns five refined candidates.
- `POST /api/stickers/:id/accept` uploads the selected runtime candidate to the Notion `generated` table, writes the accepted JSON to the Notion `history` table, clears the runtime draft, and returns the Notion page ID.
- `POST /api/stickers/:id/reject` uploads the rejected runtime candidates and optional rejection reason to the Notion `rejected` table, then clears the runtime draft.

## Notion Strategy

Notion is the persistence layer and uses four child databases under the configured Notion page: `baseline`, `generated`, `history`, and `rejected`. Runtime candidate files under `.runtime/` remain local only while the user is deciding.

Set `NOTION_TOKEN` and `NOTION_DATABASE_ID` in `.env`. `NOTION_DATABASE_ID` can be either an existing database id or the id of a blank Notion page. The server creates or reuses the required child databases inside that page.

To import the current local `data/` folder into `baseline`, `generated`, and `history`, run the server and call:

```bash
curl -X POST http://localhost:4000/api/notion/import
```

Each import table is keyed by `Relative Path`, so rerunning it updates existing Notion rows instead of creating duplicate rows. Image files are uploaded to Notion and attached to the row page, so opening the row shows the actual image. JSON files are written into the row page as a JSON code block.

The `baseline`, `generated`, and `history` tables have:

- `Name`
- `Category`: the first folder under the group, for example `lunar_new_year`
- `Content`: the actual file path under the category
- `File Type`: `image` or `json`
- `Extension`
- `Relative Path`
- `Size Bytes`
- `Updated At`

The `rejected` table has:

- `Name`
- `Record ID`
- `Theme`
- `Motion`
- `Prompt`
- `Reject Reason`
- `Selected Candidate`
- `Candidate Count`
- `Model`
- `Created At`
- `Updated At`

Opening a rejected row shows the rejected candidate images.

## Cache Cleanup Policy

Runtime draft state should be removed after Notion confirms accept or reject upload.

```txt
accept sticker
  -> mark local record as uploading
  -> upload final image and JSON to Notion
  -> if upload succeeds, remove runtime draft
  -> if upload fails, keep runtime draft for retry
```

Rejected candidates are uploaded to the Notion `rejected` table before the runtime draft is discarded.

## Next Steps

1. Connect `apps/server/src/services/notion.ts` to the Notion API.
2. Add retry handling for failed uploads.
3. Decide whether accepted generated assets should be kept locally, uploaded to durable storage, or deleted after DB sync.
4. Add authentication if the tool is exposed outside a trusted internal network.

## Current Status

Verified commands:

```bash
npm run typecheck
npm run test
npm run build
```

Security audit is currently clean:

```bash
npm audit
```
