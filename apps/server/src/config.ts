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

function positiveNumberOrDefault(value: string, defaultValue: number): number {
  const parsed = Number(value || defaultValue);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : defaultValue;
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
  imageGenerationApiKey,
  imageGenerationApiUrl,
  imageGenerationModel: firstNonEmpty(process.env.IMAGE_GENERATION_MODEL, process.env.NANO_BANANA_MODEL) || "openai/gpt-image-2",
  imageGenerationCandidateCount: Number(firstNonEmpty(process.env.IMAGE_GENERATION_CANDIDATE_COUNT) || 5),
  imageGenerationConcurrency: positiveNumberOrDefault(firstNonEmpty(process.env.IMAGE_GENERATION_CONCURRENCY), 2),
  imageGenerationBaselineReferenceCount: positiveNumberOrDefault(firstNonEmpty(process.env.IMAGE_GENERATION_BASELINE_REFERENCE_COUNT), 1),
  canonicalReferenceBlobPathname: firstNonEmpty(process.env.CANONICAL_REFERENCE_BLOB_PATHNAME) || "baseline/ding-ding-cat/turnaround.png",
  notionToken: process.env.NOTION_TOKEN ?? "",
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? "",
  blobReadWriteToken: process.env.BLOB_READ_WRITE_TOKEN ?? "",
  runtimeGeneratedRoot,
  runtimeRecordsRoot,
  vercelUrl: process.env.VERCEL_URL ?? "",
};
