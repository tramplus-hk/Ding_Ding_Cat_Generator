import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import app from "../app.js";
import { config } from "../config.js";
import { uploadReferenceSchema } from "./stickers.js";

const testPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeUploadsRoot = path.join(projectRoot, ".runtime/uploads");

async function readRuntimeUploadEntries() {
  return [...(await readdir(runtimeUploadsRoot).catch(() => []))].sort();
}

describe("uploadReferenceSchema", () => {
  test("validates a complete image upload payload", () => {
    const result = uploadReferenceSchema.safeParse({
      fileName: "cat.png",
      data: `data:image/png;base64,${testPngBase64}`,
      theme: "lunar_new_year",
      description: "dancing cat",
    });

    assert.equal(result.success, true);
  });

  test("rejects payloads missing required fields", () => {
    const cases = [
      { data: "x", theme: "a", description: "b" },
      { fileName: "x", theme: "a", description: "b" },
      { fileName: "x", data: "x", description: "b" },
      { fileName: "x", data: "x", theme: "a" },
    ];

    for (const body of cases) {
      assert.equal(uploadReferenceSchema.safeParse(body).success, false);
    }
  });

  test("keeps only supported image extensions", () => {
    const cases = [
      { fileName: "cat.png", expected: ".png" },
      { fileName: "cat.jpg", expected: ".jpg" },
      { fileName: "cat.jpeg", expected: ".jpeg" },
      { fileName: "cat.webp", expected: ".webp" },
      { fileName: "cat.gif", expected: ".gif" },
      { fileName: "cat.bmp", expected: ".png" },
      { fileName: "cat", expected: ".png" },
    ];

    for (const { fileName, expected } of cases) {
      const extension = path.extname(fileName).toLowerCase();
      const safeExtension = /\.(png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
      assert.equal(safeExtension, expected);
    }
  });
});

describe("POST /api/stickers/upload-reference", () => {
  test("fails when Notion is not configured", async () => {
    const originalNotionToken = config.notionToken;
    const originalNotionDatabaseId = config.notionDatabaseId;
    config.notionToken = "";
    config.notionDatabaseId = "";

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const runtimeUploadEntriesBefore = await readRuntimeUploadEntries();

      const uploadResponse = await fetch(`${baseUrl}/api/stickers/upload-reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "cat.png",
          data: `data:image/png;base64,${testPngBase64}`,
          theme: "reference route",
          description: "stores reference in notion",
        }),
      });

      assert.equal(uploadResponse.status, 500);
      const body = (await uploadResponse.json()) as { error?: string };
      assert.match(body.error ?? "", /Notion is not configured|NOTION_TOKEN|NOTION_DATABASE_ID/);
      assert.deepEqual(await readRuntimeUploadEntries(), runtimeUploadEntriesBefore);
    } finally {
      config.notionToken = originalNotionToken;
      config.notionDatabaseId = originalNotionDatabaseId;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
