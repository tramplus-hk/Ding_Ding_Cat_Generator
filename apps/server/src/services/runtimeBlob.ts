import type { StickerRecord } from "@sticker-platform/shared";
import { del, get, list, put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const runtimeRoot = "runtime";

export type CurrentRun = {
  recordId: string;
  runId: string;
  updatedAt: string;
};

export function shouldUseRuntimeBlob(): boolean {
  return Boolean(config.blobReadWriteToken);
}

function recordPath(id: string): string {
  return `${runtimeRoot}/records/${id}.json`;
}

function currentRunPath(): string {
  return `${runtimeRoot}/current.json`;
}

function assetPrefix(id: string, runId?: string): string {
  return runId ? `runtime/generated/${id}/${runId}/` : `${runtimeRoot}/generated/${id}/`;
}

function uploadPrefix(id: string, runId?: string): string {
  return runId ? `runtime/uploads/${id}/${runId}/` : `${runtimeRoot}/uploads/${id}/`;
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
  const reader = result.stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  return Buffer.concat(chunks);
}

async function readBlobJson<T>(pathname: string): Promise<T | undefined> {
  const body = await blobResultToBuffer(pathname);

  return body ? (JSON.parse(body.toString("utf8")) as T) : undefined;
}

async function readCurrentRunRaw(): Promise<CurrentRun | undefined> {
  return readBlobJson<CurrentRun>(currentRunPath());
}

export async function readCurrentRunBlob(): Promise<CurrentRun | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  return readCurrentRunRaw();
}

export async function writeCurrentRunBlob(run: Pick<CurrentRun, "recordId" | "runId">): Promise<CurrentRun | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  const currentRun: CurrentRun = { ...run, updatedAt: new Date().toISOString() };
  await put(currentRunPath(), `${JSON.stringify(currentRun, null, 2)}\n`, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });

  return currentRun;
}

export async function clearCurrentRunBlob(expected?: Pick<CurrentRun, "recordId" | "runId">): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  if (expected) {
    const current = await readCurrentRunRaw();
    if (!current || current.recordId !== expected.recordId || current.runId !== expected.runId) {
      return;
    }
  }

  await del(currentRunPath()).catch(() => undefined);
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

export async function uploadRuntimeCandidateBlob(recordId: string, logicalPath: string, absolutePath: string, runId?: string): Promise<string | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  const relativePath = logicalPath.replace(/^\.runtime\/generated\//, "");
  const pathname = `${assetPrefix(recordId, runId)}${path.basename(relativePath)}`;
  const body = await readFile(absolutePath);
  await put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: getMimeType(logicalPath),
  });

  return pathname;
}

export async function uploadRuntimeReferenceBlob(recordId: string, logicalPath: string, body: Buffer, runId?: string): Promise<string | undefined> {
  if (!shouldUseRuntimeBlob()) return undefined;

  const fileName = path.basename(logicalPath);
  const pathname = `${uploadPrefix(recordId, runId)}${fileName}`;
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

export async function deleteRuntimeAssetBlobs(id: string, runId?: string): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  const response = await list({ prefix: assetPrefix(id, runId) });

  if (response.blobs.length > 0) {
    await del(response.blobs.map((blob) => blob.pathname));
  }
}

export async function deleteRuntimeUploadBlobs(id: string, runId?: string): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  const response = await list({ prefix: uploadPrefix(id, runId) });

  if (response.blobs.length > 0) {
    await del(response.blobs.map((blob) => blob.pathname));
  }
}

export async function deleteRuntimeRecordBlob(id: string): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  await del(recordPath(id)).catch(() => undefined);
}

export async function deleteRuntimeBlobRun(id: string, runId?: string): Promise<void> {
  await Promise.all([deleteRuntimeAssetBlobs(id, runId), deleteRuntimeUploadBlobs(id, runId), deleteRuntimeRecordBlob(id)]);
}

export async function deleteRuntimeAssetsExceptCurrent(current?: Pick<CurrentRun, "recordId" | "runId">): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  const prefixes = [`${runtimeRoot}/generated/`, `${runtimeRoot}/uploads/`, `${runtimeRoot}/records/`];
  const responses = await Promise.all(prefixes.map((prefix) => list({ prefix })));
  const keepGenerated = current ? assetPrefix(current.recordId, current.runId) : undefined;
  const keepUploads = current ? uploadPrefix(current.recordId, current.runId) : undefined;
  const keepRecord = current ? recordPath(current.recordId) : undefined;
  const stalePathnames = responses
    .flatMap((response) => response.blobs.map((blob) => blob.pathname))
    .filter((pathname) => {
      if (keepGenerated && pathname.startsWith(keepGenerated)) return false;
      if (keepUploads && pathname.startsWith(keepUploads)) return false;
      if (keepRecord && pathname === keepRecord) return false;
      return true;
    });

  if (stalePathnames.length > 0) {
    await del(stalePathnames);
  }
}

export async function cleanupStaleRuntimeBlobs(ttlMs = 24 * 60 * 60 * 1000): Promise<void> {
  if (!shouldUseRuntimeBlob()) return;

  const current = await readCurrentRunRaw();
  const cutoff = Date.now() - ttlMs;
  const currentUpdatedAt = current ? new Date(current.updatedAt).getTime() : Number.NaN;
  const currentIsFresh = Boolean(current && Number.isFinite(currentUpdatedAt) && currentUpdatedAt >= cutoff);

  if (current && !currentIsFresh) {
    await del(currentRunPath()).catch(() => undefined);
  }

  const freshCurrent = currentIsFresh ? current : undefined;
  const prefixes = [`${runtimeRoot}/generated/`, `${runtimeRoot}/uploads/`, `${runtimeRoot}/records/`];
  const responses = await Promise.all(prefixes.map((prefix) => list({ prefix })));
  const keepGenerated = freshCurrent ? assetPrefix(freshCurrent.recordId, freshCurrent.runId) : undefined;
  const keepUploads = freshCurrent ? uploadPrefix(freshCurrent.recordId, freshCurrent.runId) : undefined;
  const keepRecord = freshCurrent ? recordPath(freshCurrent.recordId) : undefined;
  const stalePathnames = responses
    .flatMap((response) => response.blobs)
    .filter((blob) => {
      if (keepGenerated && blob.pathname.startsWith(keepGenerated)) return false;
      if (keepUploads && blob.pathname.startsWith(keepUploads)) return false;
      if (keepRecord && blob.pathname === keepRecord) return false;

      const uploadedAt = new Date(blob.uploadedAt).getTime();
      return Number.isFinite(uploadedAt) && uploadedAt < cutoff;
    })
    .map((blob) => blob.pathname);

  if (stalePathnames.length > 0) {
    await del(stalePathnames);
  }
}
