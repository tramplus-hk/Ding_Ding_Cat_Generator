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
  imageGenerationConcurrency: config.imageGenerationConcurrency,
  imageGenerationBaselineReferenceCount: config.imageGenerationBaselineReferenceCount,
  notionToken: config.notionToken,
  notionDatabaseId: config.notionDatabaseId,
  blobReadWriteToken: config.blobReadWriteToken,
};

describe("generateSticker", () => {
  before(() => {
    config.imageGenerationApiKey = "test-key";
    config.imageGenerationApiUrl = "https://example.test/v1";
    config.imageGenerationModel = "openai/gpt-image-2";
    config.imageGenerationConcurrency = 2;
    config.imageGenerationBaselineReferenceCount = 0;
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

  test("retries transient candidate request failures before reducing candidate count", async () => {
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

    assert.equal(requestCount, 3);
    assert.equal(result.candidates?.length, 2);
    assert.ok(result.candidates?.every((candidate) => candidate.endsWith(".png")));

    const candidatePath = result.candidates?.[0];
    assert.ok(candidatePath);
    await rm(path.dirname(path.dirname(path.resolve(config.runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath)))), {
      recursive: true,
      force: true,
    });
  });

  test("limits concurrent GPT Image 2 candidate requests", async () => {
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
      id: "parallel-candidates-test",
      format: "svg",
      theme: "parallel candidates",
      description: "speed up generation",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const result = await generateSticker(record, { count: 3 });

    assert.equal(result.candidates?.length, 3);
    assert.equal(maxActiveRequests, 2);
    assert.deepEqual(
      result.candidates?.map((candidate) => path.basename(candidate)),
      ["candidate-01.png", "candidate-02.png", "candidate-03.png"],
    );

    const candidatePath = result.candidates?.[0];
    assert.ok(candidatePath);
    await rm(path.dirname(path.dirname(path.resolve(config.runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath)))), {
      recursive: true,
      force: true,
    });
  });

  test("serializes GPT Image 2 edit requests with references", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const baselineDirectory = path.resolve(process.cwd(), "../..", "data/baseline/serial-edit-reference");
    const baselinePath = path.join(baselineDirectory, "ding-ding.png");
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const originalBaselineReferenceCount = config.imageGenerationBaselineReferenceCount;

    config.imageGenerationBaselineReferenceCount = 1;
    await mkdir(baselineDirectory, { recursive: true });
    await writeFile(baselinePath, pngBytes);

    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://example.test/v1/images/edits");
      assert.ok(init?.body instanceof FormData);

      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "serial-edit-test",
      format: "svg",
      theme: "serial edit",
      description: "avoid concurrent edits",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      const result = await generateSticker(record, { count: 3 });

      assert.equal(result.candidates?.length, 3);
      assert.equal(maxActiveRequests, 1);
    } finally {
      config.imageGenerationBaselineReferenceCount = originalBaselineReferenceCount;
      await rm(baselineDirectory, { recursive: true, force: true });
      await rm(path.resolve(config.runtimeGeneratedRoot, "serial_edit"), { recursive: true, force: true });
    }
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

  test("does not retry provider socket failures after a long-held request closes", async () => {
    const originalDateNow = Date.now;
    let now = 1_700_000_000_000;
    let requestCount = 0;

    Date.now = () => now;
    globalThis.fetch = (async () => {
      requestCount += 1;
      now += 180_000;
      const socketError = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause: socketError });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "long-socket-failure-test",
      format: "svg",
      theme: "socket failure",
      description: "provider times out slowly",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await assert.rejects(generateSticker(record, { count: 1 }), /provider times out slowly/i);

      assert.equal(requestCount, 1);
    } finally {
      Date.now = originalDateNow;
    }
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

  test("falls back to local baseline reference when canonical Blob reference is unavailable", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const baselineDirectory = path.resolve(process.cwd(), "../..", "data/baseline/unit-reference");
    const baselinePath = path.join(baselineDirectory, "ding-ding.png");
    const secondBaselinePath = path.join(baselineDirectory, "ding-ding-side.png");
    const requests: Array<{ url: string; body: FormData; contentType?: string }> = [];
    const originalBaselineReferenceCount = config.imageGenerationBaselineReferenceCount;

    config.imageGenerationBaselineReferenceCount = 1;
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
      assert.doesNotMatch(String(request.body.get("prompt")), /turnaround sheet/i);
      assert.doesNotMatch(String(request.body.get("prompt")), /data:image/);
      assert.equal(request.body.get("image"), null);
      assert.equal(request.body.getAll("image[]").length, 1);
      assert.ok(request.body.getAll("image[]").every((value) => value instanceof Blob));
    } finally {
      config.imageGenerationBaselineReferenceCount = originalBaselineReferenceCount;
      await rm(baselineDirectory, { recursive: true, force: true });
      await rm(path.resolve(config.runtimeGeneratedRoot, "reference_test_theme"), { recursive: true, force: true });
    }
  });

  test("falls back to local baseline reference when canonical Blob read fails", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const baselineDirectory = path.resolve(process.cwd(), "../..", "data/baseline/canonical-read-failure");
    const baselinePath = path.join(baselineDirectory, "ding-ding.png");
    const requests: Array<{ url: string; body: FormData }> = [];
    const originalBlobToken = config.blobReadWriteToken;
    const originalBaselineReferenceCount = config.imageGenerationBaselineReferenceCount;

    config.blobReadWriteToken = "test-blob-token";
    config.imageGenerationBaselineReferenceCount = 1;
    await mkdir(baselineDirectory, { recursive: true });
    await writeFile(baselinePath, pngBytes);

    globalThis.fetch = (async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "canonical-read-failure-test",
      format: "svg",
      theme: "canonical read failure",
      description: "fallback to baseline",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, {
        count: 1,
        readCanonicalReferenceBlob: async () => {
          config.blobReadWriteToken = originalBlobToken;
          throw new Error("Blob read failed");
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://example.test/v1/images/edits");
      assert.doesNotMatch(String(requests[0].body.get("prompt")), /turnaround sheet/i);
      assert.equal(requests[0].body.getAll("image[]").length, 1);
    } finally {
      config.blobReadWriteToken = originalBlobToken;
      config.imageGenerationBaselineReferenceCount = originalBaselineReferenceCount;
      await rm(baselineDirectory, { recursive: true, force: true });
      await rm(path.resolve(config.runtimeGeneratedRoot, "canonical_read_failure"), { recursive: true, force: true });
    }
  });

  test("loads canonical Blob reference before baseline references", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requests: Array<{ url: string; body: FormData }> = [];
    const originalBlobToken = config.blobReadWriteToken;
    const originalCanonicalPathname = config.canonicalReferenceBlobPathname;

    config.blobReadWriteToken = "test-blob-token";
    config.canonicalReferenceBlobPathname = "baseline/ding-ding-cat/turnaround.png";

    globalThis.fetch = (async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "canonical-reference-test",
      format: "svg",
      theme: "canonical reference",
      description: "use canonical mascot sheet",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, {
        count: 1,
        readCanonicalReferenceBlob: async (pathname) => {
          assert.equal(pathname, "baseline/ding-ding-cat/turnaround.png");
          config.blobReadWriteToken = originalBlobToken;
          return pngBytes;
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://example.test/v1/images/edits");
      assert.match(String(requests[0].body.get("prompt")), /turnaround sheet/i);
      assert.equal(requests[0].body.getAll("image[]").length, 1);
    } finally {
      config.blobReadWriteToken = originalBlobToken;
      config.canonicalReferenceBlobPathname = originalCanonicalPathname;
      await rm(path.resolve(config.runtimeGeneratedRoot, "canonical_reference"), { recursive: true, force: true });
    }
  });

  test("refinement sends only the selected candidate image", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const selectedDirectory = path.resolve(config.runtimeGeneratedRoot, "refine_selected_only", "wave");
    const selectedPath = path.join(selectedDirectory, "candidate-01.png");
    const logicalSelectedPath = path.join(".runtime/generated", path.relative(config.runtimeGeneratedRoot, selectedPath)).replace(/\\/g, "/");
    const baselineDirectory = path.resolve(process.cwd(), "../..", "data/baseline/refine-selected-only");
    const requests: Array<{ url: string; body: FormData }> = [];

    await mkdir(selectedDirectory, { recursive: true });
    await mkdir(baselineDirectory, { recursive: true });
    await writeFile(selectedPath, pngBytes);
    await writeFile(path.join(baselineDirectory, "ding-ding.png"), pngBytes);

    globalThis.fetch = (async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "refine-selected-only-test",
      format: "svg",
      theme: "refine selected only",
      description: "make the lantern bigger",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, {
        count: 1,
        selectedImagePath: logicalSelectedPath,
        refinementRequirement: "make the lantern bigger",
        referenceImagePath: ".runtime/uploads/ignored-user-reference.png",
        readCanonicalReferenceBlob: async () => {
          throw new Error("canonical reference should not be loaded during refine");
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://example.test/v1/images/edits");
      assert.match(String(requests[0].body.get("prompt")), /REFINEMENT REQUEST/i);
      assert.doesNotMatch(String(requests[0].body.get("prompt")), /turnaround sheet/i);
      const submittedImages = requests[0].body.getAll("image[]");
      assert.equal(submittedImages.length, 1);
      assert.ok(submittedImages[0] instanceof Blob);
      assert.equal((submittedImages[0] as File).name, "candidate-01.png");
    } finally {
      await rm(selectedDirectory, { recursive: true, force: true });
      await rm(baselineDirectory, { recursive: true, force: true });
      await rm(path.resolve(config.runtimeGeneratedRoot, "refine_selected_only"), { recursive: true, force: true });
    }
  });

  test("refinement can read a Blob-backed selected candidate pathname", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const selectedImageUrl = "runtime/generated/blob-backed-refine/candidate-01.png";
    const requests: Array<{ url: string; body: FormData }> = [];
    const originalBlobToken = config.blobReadWriteToken;

    config.blobReadWriteToken = "test-blob-token";
    globalThis.fetch = (async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "blob-backed-refine-test",
      format: "svg",
      theme: "blob backed refine",
      description: "refine from blob",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    try {
      await generateSticker(record, {
        count: 1,
        refinementRequirement: "make the pose clearer",
        selectedImageUrl,
        readSelectedImageBlob: async (pathname) => {
          assert.equal(pathname, selectedImageUrl);
          config.blobReadWriteToken = originalBlobToken;
          return pngBytes;
        },
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://example.test/v1/images/edits");
      assert.match(String(requests[0].body.get("prompt")), /REFINEMENT REQUEST/i);
      assert.doesNotMatch(String(requests[0].body.get("prompt")), /turnaround sheet/i);
      assert.equal(requests[0].body.getAll("image[]").length, 1);
    } finally {
      config.blobReadWriteToken = originalBlobToken;
      await rm(path.resolve(config.runtimeGeneratedRoot, "blob_backed_refine"), { recursive: true, force: true });
    }
  });

  test("fails refinement when selected candidate URL is unavailable", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const selectedImageUrl = "https://example.test/runtime/generated/refine-test/candidate-01.png";
    let providerRequestCount = 0;

    globalThis.fetch = (async (input) => {
      if (String(input) === selectedImageUrl) {
        return new Response(null, { status: 404 });
      }

      providerRequestCount += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "missing-refine-reference-test",
      format: "svg",
      theme: "missing refine reference",
      description: "refine unavailable selected candidate",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    await assert.rejects(
      generateSticker(record, {
        count: 1,
        refinementRequirement: "make the pose happier",
        selectedImageUrl,
      }),
      /Selected image reference unavailable/i,
    );
    assert.equal(providerRequestCount, 0);
  });

  test("omits user reference prompt instructions during refinement", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const selectedImageUrl = "https://example.test/runtime/generated/refine-test/candidate-01.png";
    const requests: Array<{ url: string; body: FormData }> = [];

    globalThis.fetch = (async (input, init) => {
      if (String(input) === selectedImageUrl) {
        return new Response(pngBytes, { headers: { "content-type": "image/png" } });
      }

      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });

      return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const record: StickerRecord = {
      id: "refine-prompt-reference-test",
      format: "svg",
      theme: "refine prompt reference",
      description: "refine selected candidate only",
      status: "generating",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    await generateSticker(record, {
      count: 1,
      refinementRequirement: "make the tram bell brighter",
      selectedImageUrl,
      referenceImageUrl: "runtime/uploads/user-reference.png",
    });

    assert.equal(requests.length, 1);
    const prompt = String(requests[0].body.get("prompt"));
    assert.match(prompt, /REFINEMENT REQUEST/i);
    assert.doesNotMatch(prompt, /USER-PROVIDED REFERENCE IMAGE/i);
    assert.equal(requests[0].body.getAll("image[]").length, 1);
  });
});
