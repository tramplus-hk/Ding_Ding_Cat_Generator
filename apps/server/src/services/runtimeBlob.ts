import type { StickerRecord } from "@sticker-platform/shared";
import { del, get, list, put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const runtimeRoot = "runtime";

export function shouldUseRuntimeBlob(): boolean {
  return Boolean(config.blobReadWriteToken);
}

function recordPath(id: string): string {
  return `${runtimeRoot}/records/${id}.json`;
}

function assetPrefix(id: string): string {
  return `${runtimeRoot}/generated/${id}/`;
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "image/png";
}

async function blobResultToBuffer(pathname: string): Promise<Buffer | undefined> {
  const result = await get(pathname, { access: "private", useCache: false }).catch(() => null);

  if (!result?.stream) {
    return undefined;
  }

  const chunks: Uint8Array[] = [];

  for await (const chunk of result.stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

async function readBlobJson<T>(pathname: string): Promise<T | undefined> {
  const body = await blobResultToBuffer(pathname);

  return body ? (JSON.parse(body.toString("utf8")) as T) : undefined;
}

export async function writeRuntimeRecordBlob(record: StickerRecord): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  await put(recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function readRuntimeRecordBlob(id: string): Promise<StickerRecord | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  const response = await list({ prefix: recordPath(id), limit: 1 });
  const blob = response.blobs.find((entry) => entry.pathname === recordPath(id));

  return blob ? readBlobJson<StickerRecord>(blob.pathname) : undefined;
}

export async function listRuntimeRecordBlobs(): Promise<StickerRecord[]> {
  if (!shouldUseRuntimeBlob()) return [];

  const response = await list({ prefix: `${runtimeRoot}/records/` });
  const records = await Promise.all(response.blobs.map((blob) => readBlobJson<StickerRecord>(blob.pathname)));

  return records.filter((record): record is StickerRecord => Boolean(record));
}

export async function uploadRuntimeCandidateBlob(recordId: string, logicalPath: string, absolutePath: string): Promise<string | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  const relativePath = logicalPath.replace(/^\.runtime\/generated\//, "");
  const pathname = `${assetPrefix(recordId)}${relativePath}`;
  const body = await readFile(absolutePath);
  await put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: getMimeType(logicalPath),
  });

  return pathname;
}

export async function readRuntimeBlob(pathname: string): Promise<Buffer | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  return blobResultToBuffer(pathname);
}

export async function deleteRuntimeAssetBlobs(id: string): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  const response = await list({ prefix: assetPrefix(id) });

  if (response.blobs.length > 0) {
    await del(response.blobs.map((blob) => blob.pathname));
  }
}

export async function deleteRuntimeRecordBlob(id: string): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  await del(recordPath(id)).catch(() => undefined);
}

export async function deleteRuntimeBlobRun(id: string): Promise<void> {
  await Promise.all([deleteRuntimeAssetBlobs(id), deleteRuntimeRecordBlob(id)]);
}
