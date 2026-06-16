import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const historyRoot = path.join(projectRoot, "data/history");
const recordFileName = "request.json";
const runtimeRecords = new Map<string, StickerRecord>();

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

function getRecordDirectory(record: Pick<StickerRecord, "theme" | "description">): string {
  return path.join(historyRoot, slugify(record.theme), slugify(record.description));
}

function getRecordPath(record: Pick<StickerRecord, "theme" | "description">): string {
  return path.join(getRecordDirectory(record), recordFileName);
}

function getStoredRecordPath(record: Pick<StickerRecord, "theme" | "description" | "cachePath">): string {
  return record.cachePath ? path.join(projectRoot, record.cachePath) : getRecordPath(record);
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

async function getAvailableRecordPath(record: Pick<StickerRecord, "theme" | "description">): Promise<string> {
  const themeDirectory = path.join(historyRoot, slugify(record.theme));
  const baseName = slugify(record.description);
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? baseName : `${baseName}_${index}`;
    const candidatePath = path.join(themeDirectory, candidateName, recordFileName);

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

  return path.join(historyRoot, parsedFinalPath.dir, parsedFinalPath.name, recordFileName);
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

  return [...runtimeRecords.values(), ...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getStickerRecord(id: string): Promise<StickerRecord | undefined> {
  const runtimeRecord = runtimeRecords.get(id);

  if (runtimeRecord) {
    return runtimeRecord;
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

  runtimeRecords.set(record.id, record);

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
    cachePath: existing.cachePath,
    updatedAt: new Date().toISOString(),
  };

  if (updated.cachePath) {
    await writeFile(getStoredRecordPath(updated), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  } else {
    runtimeRecords.set(id, updated);
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
  const recordDirectory = path.dirname(recordPath);

  await mkdir(recordDirectory, { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  runtimeRecords.delete(id);

  return persisted;
}

export async function deleteStickerCache(id: string): Promise<void> {
  const record = await getStickerRecord(id);

  runtimeRecords.delete(id);

  if (!record) {
    return;
  }

  if (!record.cachePath) {
    return;
  }

  const recordDirectory = path.dirname(getStoredRecordPath(record));

  await rm(recordDirectory, { force: true, recursive: true });
  await removeEmptyParentDirectories(recordDirectory);
}
