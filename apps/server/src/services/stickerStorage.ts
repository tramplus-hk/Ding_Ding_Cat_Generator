import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { listNotionHistoryRecords } from "./notion.js";
import {
  deleteRuntimeAssetBlobs,
  deleteRuntimeBlobRun,
  deleteRuntimeRecordBlob,
  listRuntimeRecordBlobs,
  readRuntimeRecordBlob,
  shouldUseRuntimeBlob,
  writeRuntimeRecordBlob,
} from "./runtimeBlob.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const historyRoot = path.join(projectRoot, "data/history");
const runtimeRecordsRoot = config.runtimeRecordsRoot;
const runtimeRecords = new Map<string, StickerRecord>();
const isRunningNodeTest = process.argv.some((argument) => argument.includes("--test")) || process.env.npm_lifecycle_event === "test";

function shouldUseNotionStorage(): boolean {
  return Boolean(config.notionToken && config.notionDatabaseId && !isRunningNodeTest);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

function getRecordDirectory(record: Pick<StickerRecord, "theme" | "description">): string {
  return path.join(historyRoot, slugify(record.theme));
}

function getRecordPath(record: Pick<StickerRecord, "theme" | "description">): string {
  return path.join(getRecordDirectory(record), `${slugify(record.description)}.json`);
}

function getStoredRecordPath(record: Pick<StickerRecord, "theme" | "description" | "cachePath">): string {
  return record.cachePath ? path.join(projectRoot, record.cachePath) : getRecordPath(record);
}

async function readRecordFile(filePath: string): Promise<StickerRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as StickerRecord;
}

function getRuntimeRecordPath(id: string): string {
  return path.join(runtimeRecordsRoot, `${id}.json`);
}

async function writeRuntimeRecord(record: StickerRecord): Promise<void> {
  runtimeRecords.set(record.id, record);

  if (shouldUseRuntimeBlob()) {
    await writeRuntimeRecordBlob(record);
    return;
  }

  await mkdir(runtimeRecordsRoot, { recursive: true });
  await writeFile(getRuntimeRecordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function readRuntimeRecord(id: string): Promise<StickerRecord | undefined> {
  const blobRecord = await readRuntimeRecordBlob(id);

  if (blobRecord) {
    return blobRecord;
  }

  return readRecordFile(getRuntimeRecordPath(id)).catch(() => undefined);
}

async function listRuntimeRecords(): Promise<StickerRecord[]> {
  const blobRecords = await listRuntimeRecordBlobs();

  if (blobRecords.length > 0) {
    return blobRecords;
  }

  const entries = await readdir(runtimeRecordsRoot, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
      .map((entry) => readRecordFile(path.join(runtimeRecordsRoot, entry.name)).catch(() => undefined)),
  );

  return records.filter((record): record is StickerRecord => Boolean(record));
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

async function getAvailableRecordPath(record: Pick<StickerRecord, "theme" | "description">): Promise<string> {
  const themeDirectory = path.join(historyRoot, slugify(record.theme));
  const baseName = slugify(record.description);
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? baseName : `${baseName}_${index}`;
    const candidatePath = path.join(themeDirectory, `${candidateName}.json`);

    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }

    index += 1;
  }
}

function getRecordPathForFinalImage(record: StickerRecord): string | undefined {
  if (!record.result?.localPath?.startsWith("data/generated/")) {
    return undefined;
  }

  const relativeFinalPath = path.relative(path.join(projectRoot, "data/generated"), path.join(projectRoot, record.result.localPath));
  const parsedFinalPath = path.parse(relativeFinalPath);

  return path.join(historyRoot, parsedFinalPath.dir, `${parsedFinalPath.name}.json`);
}

async function listRequestJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listRequestJsonFiles(entryPath);
      }

      return entry.isFile() && path.extname(entry.name) === ".json" ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function removeEmptyParentDirectories(startDirectory: string): Promise<void> {
  let currentDirectory = path.dirname(startDirectory);

  while (currentDirectory.startsWith(historyRoot) && currentDirectory !== historyRoot) {
    const entries = await readdir(currentDirectory).catch(() => []);

    if (entries.length > 0) {
      return;
    }

    await rmdir(currentDirectory);
    currentDirectory = path.dirname(currentDirectory);
  }
}

export async function listStickerRecords(): Promise<StickerRecord[]> {
  const draftRecords = [...runtimeRecords.values(), ...(await listRuntimeRecords())];
  const uniqueDraftRecords = Array.from(new Map(draftRecords.map((record) => [record.id, record])).values());

  if (shouldUseNotionStorage()) {
    const records = await listNotionHistoryRecords();

    return [...uniqueDraftRecords, ...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const filePaths = await listRequestJsonFiles(historyRoot);
  const records = await Promise.all(filePaths.map(readRecordFile));

  return [...uniqueDraftRecords, ...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getStickerRecord(id: string): Promise<StickerRecord | undefined> {
  const runtimeRecord = runtimeRecords.get(id);

  if (runtimeRecord) {
    return runtimeRecord;
  }

  const persistedRuntimeRecord = await readRuntimeRecord(id);

  if (persistedRuntimeRecord) {
    runtimeRecords.set(id, persistedRuntimeRecord);
    return persistedRuntimeRecord;
  }

  const records = await listStickerRecords();
  return records.find((record) => record.id === id);
}

export async function createStickerRecord(input: CreateStickerInput): Promise<StickerRecord> {
  const now = new Date().toISOString();

  const record: StickerRecord = {
    ...input,
    id: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  await writeRuntimeRecord(record);

  return record;
}

export async function updateStickerRecord(
  id: string,
  patch: Partial<Omit<StickerRecord, "id" | "createdAt">>,
): Promise<StickerRecord> {
  const existing = await getStickerRecord(id);

  if (!existing) {
    throw new Error(`Sticker record not found: ${id}`);
  }

  const updated = {
    ...existing,
    ...patch,
    cachePath: patch.cachePath ?? existing.cachePath,
    updatedAt: new Date().toISOString(),
  };

  if (updated.cachePath) {
    if (shouldUseNotionStorage()) {
      await writeRuntimeRecord(updated);
      return updated;
    }

    await writeFile(getStoredRecordPath(updated), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  } else {
    await writeRuntimeRecord(updated);
  }

  return updated;
}

export async function persistStickerRecord(id: string): Promise<StickerRecord> {
  const existing = await getStickerRecord(id);

  if (!existing) {
    throw new Error(`Sticker record not found: ${id}`);
  }

  const recordPath = existing.cachePath
    ? getStoredRecordPath(existing)
    : (getRecordPathForFinalImage(existing) ?? (await getAvailableRecordPath(existing)));
  const persisted = {
    ...existing,
    cachePath: path.relative(projectRoot, recordPath),
    updatedAt: new Date().toISOString(),
  };

  if (shouldUseNotionStorage()) {
    runtimeRecords.delete(id);
    await deleteRuntimeRecordBlob(id);
    return persisted;
  }

  const recordDirectory = path.dirname(recordPath);

  await mkdir(recordDirectory, { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  runtimeRecords.delete(id);
  await rm(getRuntimeRecordPath(id), { force: true });
  await deleteRuntimeRecordBlob(id);

  return persisted;
}

export async function deleteStickerRuntimeAssets(id: string): Promise<void> {
  await deleteRuntimeAssetBlobs(id);
}

export async function deleteStickerCache(id: string): Promise<void> {
  const record = await getStickerRecord(id);

  runtimeRecords.delete(id);
  await rm(getRuntimeRecordPath(id), { force: true });
  await deleteRuntimeBlobRun(id);

  if (!record || shouldUseNotionStorage()) {
    return;
  }

  if (!record.cachePath) {
    return;
  }

  const recordDirectory = path.dirname(getStoredRecordPath(record));

  await rm(recordDirectory, { force: true, recursive: true });
  await removeEmptyParentDirectories(recordDirectory);
}
