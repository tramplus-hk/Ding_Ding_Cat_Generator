import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

describe("streamRequest network errors", () => {
  test("adds API location context when the streaming fetch rejects", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /Could not reach the sticker API at \$\{apiBaseUrl \|\| "the Vite \/api proxy"\}/);
    assert.match(source, /streaming sticker API request/);
  });

  test("explains browser progress stream read failures", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /Live generation progress stream disconnected/);
    assert.match(source, /original browser stream error/);
  });

  test("polls the sticker record after a progress stream disconnect", async () => {
    const source = await readFile(new URL("./api.ts", import.meta.url), "utf8");

    assert.match(source, /pollGeneratedSticker/);
    assert.match(source, /while \(Date\.now\(\) < deadline\)/);
    assert.match(source, /record\.status === "generating"/);
  });
});
