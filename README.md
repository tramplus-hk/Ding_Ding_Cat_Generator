# Sticker Generation Platform

Internal Vite + TypeScript skeleton for generating stickers with Nano Banana 2, reviewing results locally, and uploading only final accepted JSON records to Notion.

## Apps

- `apps/web`: Vite React frontend.
- `apps/server`: Express TypeScript backend.
- `packages/shared`: shared schemas and types.

## Intended Flow

1. User submits sticker prompt from the web app.
2. Server caches the request JSON locally.
3. Server sends the request to Nano Banana 2.
4. User reviews the generated result.
5. On acceptance, server uploads the final JSON to Notion.
6. After Notion confirms success, server removes the local JSON cache.

## Commands

```bash
npm install
npm run dev
```

## Data Layout

```txt
data/
  baseline/
    <category>/
      <sticker-content>/
  generated/
    <category>/
      <sticker-content>/
  history/
    <category>/
      <sticker-content>/
        request.json
```
