import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const originalEnv = {
  IMAGE_GENERATION_API_KEY: process.env.IMAGE_GENERATION_API_KEY,
  IMAGE_GENERATION_API_URL: process.env.IMAGE_GENERATION_API_URL,
  IMAGE_GENERATION_MODEL: process.env.IMAGE_GENERATION_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  NANO_BANANA_API_KEY: process.env.NANO_BANANA_API_KEY,
  NANO_BANANA_API_URL: process.env.NANO_BANANA_API_URL,
  NANO_BANANA_MODEL: process.env.NANO_BANANA_MODEL,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  IMAGE_GENERATION_CANDIDATE_COUNT: process.env.IMAGE_GENERATION_CANDIDATE_COUNT,
  IMAGE_GENERATION_CONCURRENCY: process.env.IMAGE_GENERATION_CONCURRENCY,
  IMAGE_GENERATION_BASELINE_REFERENCE_COUNT: process.env.IMAGE_GENERATION_BASELINE_REFERENCE_COUNT,
  CANONICAL_REFERENCE_BLOB_PATHNAME: process.env.CANONICAL_REFERENCE_BLOB_PATHNAME,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadConfig() {
  return import(`../config.js?test=${Date.now()}-${Math.random()}`);
}

describe("config", () => {
  afterEach(() => {
    restoreEnv();
  });

  test("uses the next image generation key when OPENAI_API_KEY is empty", async () => {
    process.env.IMAGE_GENERATION_API_KEY = "";
    process.env.OPENAI_API_KEY = "";
    process.env.NANO_BANANA_API_KEY = "nano-key";
    process.env.AI_GATEWAY_API_KEY = "gateway-key";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationApiKey, "nano-key");
  });

  test("prefers generic image generation model and URL over legacy Nano Banana names", async () => {
    process.env.IMAGE_GENERATION_API_URL = "https://generic.example/v1";
    process.env.IMAGE_GENERATION_MODEL = "openai/gpt-image-2";
    process.env.NANO_BANANA_API_URL = "https://legacy.example/v1";
    process.env.NANO_BANANA_MODEL = "google/gemini-3.1-flash-image-preview";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationApiUrl, "https://generic.example/v1");
    assert.equal(config.imageGenerationModel, "openai/gpt-image-2");
  });

  test("uses direct OpenAI image API by default when OPENAI_API_KEY is selected", async () => {
    process.env.IMAGE_GENERATION_API_KEY = "";
    process.env.IMAGE_GENERATION_API_URL = "";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.NANO_BANANA_API_KEY = "";
    process.env.NANO_BANANA_API_URL = "";
    process.env.AI_GATEWAY_API_KEY = "";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationApiKey, "openai-key");
    assert.equal(config.imageGenerationApiUrl, "https://api.openai.com/v1");
  });

  test("keeps Vercel AI Gateway default when AI_GATEWAY_API_KEY is selected", async () => {
    process.env.IMAGE_GENERATION_API_KEY = "";
    process.env.IMAGE_GENERATION_API_URL = "";
    process.env.OPENAI_API_KEY = "";
    process.env.NANO_BANANA_API_KEY = "";
    process.env.NANO_BANANA_API_URL = "";
    process.env.AI_GATEWAY_API_KEY = "gateway-key";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationApiKey, "gateway-key");
    assert.equal(config.imageGenerationApiUrl, "https://ai-gateway.vercel.sh/v1");
  });

  test("generates five candidates by default", async () => {
    process.env.IMAGE_GENERATION_CANDIDATE_COUNT = "";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationCandidateCount, 5);
  });

  test("limits image generation concurrency to two by default", async () => {
    process.env.IMAGE_GENERATION_CONCURRENCY = "";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationConcurrency, 2);
  });

  test("uses default image generation concurrency when configured value is invalid", async () => {
    process.env.IMAGE_GENERATION_CONCURRENCY = "not-a-number";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationConcurrency, 2);
  });

  test("uses a whole number for configured image generation concurrency", async () => {
    process.env.IMAGE_GENERATION_CONCURRENCY = "2.9";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationConcurrency, 2);
  });

  test("uses one baseline reference by default", async () => {
    process.env.IMAGE_GENERATION_BASELINE_REFERENCE_COUNT = "";

    const { config } = await loadConfig();

    assert.equal(config.imageGenerationBaselineReferenceCount, 1);
  });

  test("uses canonical reference blob pathname override", async () => {
    process.env.CANONICAL_REFERENCE_BLOB_PATHNAME = "custom/turnaround.png";

    const { config } = await loadConfig();

    assert.equal(config.canonicalReferenceBlobPathname, "custom/turnaround.png");
  });

  test("uses default canonical reference blob pathname", async () => {
    process.env.CANONICAL_REFERENCE_BLOB_PATHNAME = "";

    const { config } = await loadConfig();

    assert.equal(config.canonicalReferenceBlobPathname, "baseline/ding-ding-cat/turnaround.png");
  });
});
