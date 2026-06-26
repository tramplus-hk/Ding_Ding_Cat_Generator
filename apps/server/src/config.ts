import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeGeneratedRoot = process.env.VERCEL
  ? path.join("/tmp", "sticker-platform", "runtime", "generated")
  : path.join(projectRoot, ".runtime/generated");
const runtimeRecordsRoot = process.env.VERCEL
  ? path.join("/tmp", "sticker-platform", "runtime", "records")
  : path.join(projectRoot, ".runtime/records");

dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config();

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined && value !== "") ?? "";
}

const imageGenerationApiKey = firstNonEmpty(
  process.env.IMAGE_GENERATION_API_KEY,
  process.env.OPENAI_API_KEY,
  process.env.NANO_BANANA_API_KEY,
  process.env.AI_GATEWAY_API_KEY,
);
const imageGenerationApiUrl = firstNonEmpty(process.env.IMAGE_GENERATION_API_URL, process.env.NANO_BANANA_API_URL)
  || (imageGenerationApiKey && imageGenerationApiKey === process.env.AI_GATEWAY_API_KEY
    ? "https://ai-gateway.vercel.sh/v1"
    : "https://api.openai.com/v1");

export const config = {
  port: Number(process.env.SERVER_PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  nanoBananaApiKey: process.env.NANO_BANANA_API_KEY ?? process.env.AI_GATEWAY_API_KEY ?? "",
  nanoBananaApiUrl: process.env.NANO_BANANA_API_URL ?? "https://ai-gateway.vercel.sh/v1",
  nanoBananaModel: process.env.NANO_BANANA_MODEL ?? "google/gemini-3.1-flash-image-preview",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "models/gemini-2.5-flash-image-preview",
  /** GPT Image 2 via AI Gateway — no base64 refs, sends files as multipart form data. */
  gptImageModel: process.env.GPT_IMAGE_MODEL || firstNonEmpty(process.env.IMAGE_GENERATION_MODEL, process.env.NANO_BANANA_MODEL) || "openai/gpt-image-2",
  imageGenerationApiKey,
  imageGenerationApiUrl,
  imageGenerationModel: firstNonEmpty(process.env.IMAGE_GENERATION_MODEL, process.env.NANO_BANANA_MODEL) || "openai/gpt-image-2",
  imageGenerationCandidateCount: Number(firstNonEmpty(process.env.IMAGE_GENERATION_CANDIDATE_COUNT) || 5),
  notionToken: process.env.NOTION_TOKEN ?? "",
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? "",
  blobReadWriteToken: process.env.BLOB_READ_WRITE_TOKEN ?? "",
  runtimeGeneratedRoot,
  runtimeRecordsRoot,
  vercelUrl: process.env.VERCEL_URL ?? "",
};
