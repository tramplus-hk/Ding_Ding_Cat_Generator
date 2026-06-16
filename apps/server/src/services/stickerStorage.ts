import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const historyRoot = path.join(projectRoot, "data/history");
const recordFileName = "request.json";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

function getRecordDirectory(record: Pick<StickerRecord, "category" | "stickerContent">): string {
  return path.join(historyRoot, slugify(record.category), slugify(record.stickerContent));
}

function getRecordPath(record: Pick<StickerRecord, "category" | "stickerContent">): string {
  return path.join(getRecordDirectory(record), recordFileName);
}

function getRelativeRecordPath(record: Pick<StickerRecord, "category" | "stickerContent">): string {
  return path.relative(projectRoot, getRecordPath(record));
}

async function readRecordFile(filePath: string): Promise<StickerRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as StickerRecord;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

async function listRequestJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listRequestJsonFiles(entryPath);
      }

      return entry.isFile() && entry.name === recordFileName ? [entryPath] : [];
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
  const filePaths = await listRequestJsonFiles(historyRoot);
  const records = await Promise.all(filePaths.map(readRecordFile));

  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getStickerRecord(id: string): Promise<StickerRecord | undefined> {
  const records = await listStickerRecords();
  return records.find((record) => record.id === id);
}

export async function createStickerRecord(input: CreateStickerInput): Promise<StickerRecord> {
  const now = new Date().toISOString();
  const recordPath = getRecordPath(input);

  if (await pathExists(recordPath)) {
    const existing = await readRecordFile(recordPath);
    const error = new Error(
      `Sticker cache already exists for ${input.category}/${input.stickerContent}: ${existing.id}`,
    );

    Object.assign(error, { statusCode: 409 });
    throw error;
  }

  const record: StickerRecord = {
    ...input,
    id: randomUUID(),
    status: "pending",
    cachePath: getRelativeRecordPath(input),
    createdAt: now,
    updatedAt: now,
  };

  const recordDirectory = getRecordDirectory(record);

  await mkdir(recordDirectory, { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

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
    cachePath: getRelativeRecordPath({ ...existing, ...patch }),
    updatedAt: new Date().toISOString(),
  };

  await writeFile(getRecordPath(updated), `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  return updated;
}

export async function deleteStickerCache(id: string): Promise<void> {
  const record = await getStickerRecord(id);

  if (!record) {
    return;
  }

  const recordDirectory = getRecordDirectory(record);

  await rm(recordDirectory, { force: true, recursive: true });
  await removeEmptyParentDirectories(recordDirectory);
}
