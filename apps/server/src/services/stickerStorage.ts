import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";
import { randomUUID } from "node:crypto";

const records = new Map<string, StickerRecord>();

export async function listStickerRecords(): Promise<StickerRecord[]> {
  return [...records.values()];
}

export async function getStickerRecord(id: string): Promise<StickerRecord | undefined> {
  return records.get(id);
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

  records.set(record.id, record);
  return record;
}

export async function updateStickerRecord(
  id: string,
  patch: Partial<Omit<StickerRecord, "id" | "createdAt">>,
): Promise<StickerRecord> {
  const existing = records.get(id);

  if (!existing) {
    throw new Error(`Sticker record not found: ${id}`);
  }

  const updated = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  records.set(id, updated);
  return updated;
}

export async function deleteStickerCache(id: string): Promise<void> {
  records.delete(id);
}
