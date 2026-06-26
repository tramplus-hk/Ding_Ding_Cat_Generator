import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

async function loadPollGeneratedSticker() {
  const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");
  const inProgressFunction = source.match(/function isGenerationInProgress[\s\S]*?\n}\n/)?.[0];
  const pollFunction = source.match(/async function pollGeneratedSticker[\s\S]*?\n}\n/)?.[0];

  assert.ok(inProgressFunction);
  assert.ok(pollFunction);

  const executableSource = `${inProgressFunction}\n${pollFunction}`
    .replaceAll(": StickerRecord", "")
    .replaceAll(": string", "")
    .replaceAll(": boolean", "")
    .replaceAll(": Promise<StickerRecord>", "");

  return (getSticker, wait, Date) => {
    return Function(
      "getSticker",
      "wait",
      "Date",
      "streamRecoveryTimeoutMs",
      "streamRecoveryPollMs",
      `${executableSource}\nreturn pollGeneratedSticker;`,
    )(getSticker, wait, Date, 12 * 60 * 1000, 2_000);
  };
}

describe("generation polling API", () => {
  test("uploads reference images with optional runtime identifiers", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /recordId\?: string/);
    assert.match(source, /runId\?: string/);
    assert.match(source, /JSON\.stringify\(\{ fileName, data, theme, description, recordId, runId \}\)/);
  });

  test("starts generation with a POST and polls the sticker record", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /async function pollGeneratedSticker/);
    assert.match(source, /record\.status === "generated"/);
    assert.match(source, /record\.status === "pending"/);
    assert.match(source, /record\.status === "generating"/);
    assert.match(source, /!isGenerationInProgress\(record\)/);
    assert.match(source, /return request<StickerRecord>\(`\/api\/stickers\/\$\{id\}\/generate`/);
    assert.doesNotMatch(source, /text\/event-stream/);
    assert.doesNotMatch(source, /getReader\(/);
  });

  test("polling stops on non-generating terminal statuses", async () => {
    const createPollGeneratedSticker = await loadPollGeneratedSticker();
    const records = [{ status: "pending" }, { status: "approved" }];
    let pollCount = 0;
    let waitCount = 0;
    const pollGeneratedSticker = createPollGeneratedSticker(
      async () => {
        const record = records[pollCount++];

        if (!record) {
          throw new Error("Unexpected extra poll");
        }

        return record;
      },
      async () => {
        waitCount += 1;
      },
      { now: () => 0 },
    );

    await assert.rejects(() => pollGeneratedSticker("sticker-1"), /Generation stopped with status approved/);
    assert.equal(pollCount, 2);
    assert.equal(waitCount, 1);
  });

  test("exports current sticker restore API", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /export function getCurrentSticker\(\): Promise<\{ record: StickerRecord \| null \}>/);
    assert.match(source, /request<\{ record: StickerRecord \| null \}>\("\/api\/stickers\/current"\)/);
  });
});
