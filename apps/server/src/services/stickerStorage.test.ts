import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createStickerRecord,
  deleteStickerCache,
  getStickerRecord,
  persistStickerRecord,
  updateStickerRecord,
} from "./stickerStorage.js";

const projectRoot = path.resolve(process.cwd(), "../..");

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

describe("stickerStorage", () => {
  test("keeps draft records in memory and persists JSON only on accept", async () => {
    const suffix = randomUUID();
    const record = await createStickerRecord({
      format: "svg",
      theme: `test theme ${suffix}`,
      description: "storage lifecycle test",
    });

    assert.equal(record.status, "pending");
    assert.equal(record.cachePath, undefined);

    const expectedCachePath = `data/history/test_theme_${slugify(suffix)}/storage_lifecycle_test.json`;
    const absoluteCachePath = path.join(projectRoot, expectedCachePath);
    assert.equal(await exists(absoluteCachePath), false);

    const updated = await updateStickerRecord(record.id, { status: "rejected" });
    assert.equal(updated.status, "rejected");

    const persisted = await persistStickerRecord(record.id);
    assert.equal(persisted.cachePath, expectedCachePath);
    assert.equal(await exists(absoluteCachePath), true);

    const cachedJson = JSON.parse(await readFile(absoluteCachePath, "utf8")) as { status: string };
    assert.equal(cachedJson.status, "rejected");

    await deleteStickerCache(record.id);

    assert.equal(await getStickerRecord(record.id), undefined);
    assert.equal(await exists(path.dirname(absoluteCachePath)), false);
  });

  test("allows duplicate motions and persists them with indexed cache paths", async () => {
    const suffix = randomUUID();
    const input = {
      format: "svg" as const,
      theme: `duplicate ${suffix}`,
      description: "duplicate test",
    };

    const first = await createStickerRecord(input);
    const second = await createStickerRecord(input);
    const firstPersisted = await persistStickerRecord(first.id);
    const secondPersisted = await persistStickerRecord(second.id);

    assert.equal(firstPersisted.cachePath, `data/history/duplicate_${slugify(suffix)}/duplicate_test.json`);
    assert.equal(secondPersisted.cachePath, `data/history/duplicate_${slugify(suffix)}/duplicate_test_1.json`);

    await deleteStickerCache(first.id);
    await deleteStickerCache(second.id);
  });

  test("matches history motion name to accepted generated image name", async () => {
    const suffix = randomUUID();
    const record = await createStickerRecord({
      format: "svg",
      theme: `history ${suffix}`,
      description: "dance",
    });
    const updated = await updateStickerRecord(record.id, {
      result: {
        provider: "gpt-image-2",
        format: "svg",
        localPath: `data/generated/history_${slugify(suffix)}/dance_2.png`,
      },
    });
    const persisted = await persistStickerRecord(updated.id);

    assert.equal(persisted.cachePath, `data/history/history_${slugify(suffix)}/dance_2.json`);

    await deleteStickerCache(record.id);
  });
});
