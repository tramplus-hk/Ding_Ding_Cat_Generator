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
    delete process.env.IMAGE_GENERATION_API_KEY;
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
});
