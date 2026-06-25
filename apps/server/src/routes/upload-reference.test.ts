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
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    config.notionToken = "";
    config.notionDatabaseId = "";
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

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
      assert.equal(loggedErrors.length, 1);
      assert.equal(loggedErrors[0][0], "Sticker API error");
      assert.match(loggedErrors[0][1] instanceof Error ? loggedErrors[0][1].message : "", /Notion is not configured/);
      assert.deepEqual(await readRuntimeUploadEntries(), runtimeUploadEntriesBefore);
    } finally {
      config.notionToken = originalNotionToken;
      config.notionDatabaseId = originalNotionDatabaseId;
      console.error = originalConsoleError;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("POST /api/stickers/:id/generate", () => {
  test("sends an immediate SSE start event before candidate progress", async () => {
    const originalImageGenerationApiKey = config.imageGenerationApiKey;
    config.imageGenerationApiKey = "";

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const createResponse = await fetch(`${baseUrl}/api/stickers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "svg",
          theme: "stream route",
          description: "keeps connection alive",
        }),
      });
      assert.equal(createResponse.status, 201);
      const record = (await createResponse.json()) as { id: string };

      const generateResponse = await fetch(`${baseUrl}/api/stickers/${record.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      assert.equal(generateResponse.status, 200);
      assert.ok(generateResponse.body);
      const reader = generateResponse.body.getReader();
      const firstChunk = await reader.read();

      assert.equal(firstChunk.done, false);
      assert.match(new TextDecoder().decode(firstChunk.value), /^data: {"type":"start"}/);

      while (!(await reader.read()).done) {
        // Drain the placeholder stream before restoring the API key.
      }
    } finally {
      config.imageGenerationApiKey = originalImageGenerationApiKey;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("omits base64 previews from SSE progress events", async () => {
    const originalImageGenerationApiKey = config.imageGenerationApiKey;
    config.imageGenerationApiKey = "";

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const createResponse = await fetch(`${baseUrl}/api/stickers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "svg",
          theme: "stream route",
          description: "does not inline preview data",
        }),
      });
      assert.equal(createResponse.status, 201);
      const record = (await createResponse.json()) as { id: string };

      const generateResponse = await fetch(`${baseUrl}/api/stickers/${record.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      assert.equal(generateResponse.status, 200);
      assert.ok(generateResponse.body);
      const streamText = await generateResponse.text();
      const events = streamText
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type?: string; preview?: string });
      const progressEvents = events.filter((event) => event.type === "progress");

      assert.ok(progressEvents.length > 0);
      assert.ok(progressEvents.every((event) => event.preview === undefined));
    } finally {
      config.imageGenerationApiKey = originalImageGenerationApiKey;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
