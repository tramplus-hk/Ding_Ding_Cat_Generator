import type { StickerRecord } from "@sticker-platform/shared";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { config } from "../config.js";
import { generateSticker } from "./imageGeneration.js";

const originalFetch = globalThis.fetch;
const originalConfig = {
  imageGenerationApiKey: config.imageGenerationApiKey,
  imageGenerationApiUrl: config.imageGenerationApiUrl,
  imageGenerationModel: config.imageGenerationModel,
  notionToken: config.notionToken,
  notionDatabaseId: config.notionDatabaseId,
  blobReadWriteToken: config.blobReadWriteToken,
};

describe("generateSticker", () => {
  before(() => {
    config.imageGenerationApiKey = "test-key";
    config.imageGenerationApiUrl = "https://example.test/v1";
    config.imageGenerationModel = "openai/gpt-image-2";
    config.notionToken = "";
    config.notionDatabaseId = "";
    config.blobReadWriteToken = "";
  });

  after(() => {
    globalThis.fetch = originalFetch;
    Object.assign(config, originalConfig);
  });

  test("requests GPT Image 2 generations and writes decoded PNG candidates", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requests: Array<{ url: string; body: { model?: string; prompt?: string; n?: number } }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as { model?: string; prompt?: string; n?: number },
      });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "gpt-image-2-test",
      format: "svg",
      theme: "test theme",
      description: "wave hello",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const result = await generateSticker(record, { count: 2 });

    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, "https://example.test/v1/images/generations");
      assert.equal(request.body.model, "openai/gpt-image-2");
      assert.equal(typeof request.body.prompt, "string");
      assert.match(request.body.prompt ?? "", /Sticker description: wave hello/);
      assert.equal(request.body.n, 1);
    }

    assert.equal(result.candidates?.length, 2);
    assert.equal(result.provider, "gpt-image-2");
    assert.ok(result.candidates?.every((candidate) => candidate.endsWith(".png")));

    const firstCandidate = result.candidates?.[0];
    assert.ok(firstCandidate);
    const firstCandidatePath = path.resolve(
      config.runtimeGeneratedRoot,
      path.relative(".runtime/generated", firstCandidate),
    );
    assert.deepEqual(await readFile(firstCandidatePath), pngBytes);

    await rm(path.dirname(path.dirname(firstCandidatePath)), { recursive: true, force: true });
  });

  test("keeps successful candidates when another candidate request fails", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;

      if (requestCount === 2) {
        throw new TypeError("fetch failed");
      }

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "partial-success-test",
      format: "svg",
      theme: "partial success",
      description: "one model request fails",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const result = await generateSticker(record, { count: 2 });

    assert.equal(requestCount, 2);
    assert.equal(result.candidates?.length, 1);
    assert.ok(result.candidates?.[0]?.endsWith(".png"));

    const candidatePath = result.candidates?.[0];
    assert.ok(candidatePath);
    await rm(path.dirname(path.dirname(path.resolve(config.runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath)))), {
      recursive: true,
      force: true,
    });
  });

  test("requests GPT Image 2 candidates sequentially", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let activeRequests = 0;
    let maxActiveRequests = 0;
    globalThis.fetch = (async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "sequential-candidates-test",
      format: "svg",
      theme: "sequential candidates",
      description: "avoid gateway socket pressure",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const result = await generateSticker(record, { count: 3 });

    assert.equal(result.candidates?.length, 3);
    assert.equal(maxActiveRequests, 1);

    const candidatePath = result.candidates?.[0];
    assert.ok(candidatePath);
    await rm(path.dirname(path.dirname(path.resolve(config.runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath)))), {
      recursive: true,
      force: true,
    });
  });

  test("explains upstream socket failures when every candidate request fails", async () => {
    globalThis.fetch = (async () => {
      const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause: socketError });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "socket-failure-test",
      format: "svg",
      theme: "socket failure",
      description: "all provider requests fail",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    await assert.rejects(
      generateSticker(record, { count: 1 }),
      /Image provider connection closed while receiving a response.*UND_ERR_SOCKET.*all provider requests fail/i,
    );
  });

  test("logs candidate progress while generating placeholder assets", async () => {
    const originalApiKey = config.imageGenerationApiKey;
    const originalConsoleInfo = console.info;
    const messages: string[] = [];

    config.imageGenerationApiKey = "";
    console.info = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };

    const record: StickerRecord = {
      id: "log-test-gpt-image-2",
      format: "svg",
      theme: "debug logs",
      description: "terminal progress",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, { count: 1 });
    } finally {
      config.imageGenerationApiKey = originalApiKey;
      console.info = originalConsoleInfo;
    }

    assert.ok(messages.some((message) => message.includes("[sticker-generation] candidate_started")));
    assert.ok(messages.some((message) => message.includes("recordId=log-test-gpt-image-2")));
    assert.ok(messages.some((message) => message.includes("candidate=1/1")));
    assert.ok(messages.some((message) => message.includes("[sticker-generation] candidate_file_written")));
    assert.ok(messages.some((message) => message.includes("[sticker-generation] candidate_progress")));
    assert.ok(messages.some((message) => message.includes("[sticker-generation] generation_completed")));
  });

  test("sends baseline references as multipart image edit attachments", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const baselineDirectory = path.resolve(process.cwd(), "../..", "data/baseline/unit-reference");
    const baselinePath = path.join(baselineDirectory, "ding-ding.png");
    const secondBaselinePath = path.join(baselineDirectory, "ding-ding-side.png");
    const requests: Array<{ url: string; body: FormData; contentType?: string }> = [];

    await mkdir(baselineDirectory, { recursive: true });
    await writeFile(baselinePath, pngBytes);
    await writeFile(secondBaselinePath, pngBytes);

    globalThis.fetch = (async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({
        url: String(input),
        body: init.body,
        contentType: (init.headers as Record<string, string> | undefined)?.["Content-Type"],
      });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "gpt-image-2-reference-test",
      format: "svg",
      theme: "reference test theme",
      description: "use mascot reference",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, { count: 1 });

      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.url, "https://example.test/v1/images/edits");
      assert.equal(request.contentType, undefined);
      assert.equal(request.body.get("model"), "openai/gpt-image-2");
      assert.equal(request.body.get("n"), "1");
      assert.equal(request.body.get("output_format"), "png");
      assert.equal(typeof request.body.get("prompt"), "string");
      assert.doesNotMatch(String(request.body.get("prompt")), /data:image/);
      assert.equal(request.body.get("image"), null);
      assert.equal(request.body.getAll("image[]").length, 2);
      assert.ok(request.body.getAll("image[]").every((value) => value instanceof Blob));
    } finally {
      await rm(baselineDirectory, { recursive: true, force: true });
      await rm(path.resolve(config.runtimeGeneratedRoot, "reference_test_theme"), { recursive: true, force: true });
    }
  });
});
