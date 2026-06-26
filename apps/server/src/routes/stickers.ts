import { createStickerSchema } from "@sticker-platform/shared";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../config.js";
import { sendGenerationRun } from "../services/generationJobs.js";
import { archiveNotionPage, getAvailableNotionContentName, getFilePropertyUrl, getRichTextProperty, listDataFolderRows, uploadAcceptedStickerRecord, uploadDataFolderFile, uploadRejectedStickerRun } from "../services/notion.js";
import {
  createStickerRecord,
  deleteStickerCache,
  deleteStickerRuntimeAssets,
  getStickerRecord,
  listStickerRecords,
  updateStickerRecord,
} from "../services/stickerStorage.js";
import { cleanupStaleRuntimeBlobs, clearCurrentRunBlob, deleteRuntimeAssetsExceptCurrent, readCurrentRunBlob, readRuntimeBlob, uploadRuntimeReferenceBlob, writeCurrentRunBlob } from "../services/runtimeBlob.js";

type StickerRecord = Awaited<ReturnType<typeof getStickerRecord>> extends infer T ? NonNullable<T> : never;

function logStickerRouteStep(step: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.info(`[sticker-route] ${step} ${new Date().toISOString()}${details ? ` ${details}` : ""}`);
}

function logStickerRouteError(step: string, error: unknown, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.error(`[sticker-route] ${step} ${new Date().toISOString()}${details ? ` ${details}` : ""}`, error);
}

export const stickersRouter = Router();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeGeneratedRoot = config.runtimeGeneratedRoot;
const runtimeUploadsRoot = process.env.VERCEL
  ? path.join("/tmp", "sticker-platform", "runtime", "uploads")
  : path.join(projectRoot, ".runtime/uploads");

export const uploadReferenceSchema = z.object({
  fileName: z.string().min(1),
  data: z.string().min(1),
  theme: z.string().min(1),
  description: z.string().min(1),
  recordId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});

const generateStickerInputSchema = z.object({
  theme: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  referenceImagePath: z.string().min(1).optional(),
  referenceImageUrl: z.string().min(1).optional(),
});

const refineStickerSchema = z.object({
  selectedPath: z.string().min(1),
  requirement: z.string().min(1),
  referenceImagePath: z.string().min(1).optional(),
  referenceImageUrl: z.string().min(1).optional(),
});

const acceptStickerSchema = z.object({
  selectedPath: z.string().min(1).optional(),
  imageData: z.string().min(1).optional(),
});

const rejectStickerSchema = z.object({
  reason: z.string().optional(),
});

async function enqueueGenerationRun(
  record: StickerRecord,
  input: {
    mode: "generate" | "refine";
    referenceImagePath?: string;
    referenceImageUrl?: string;
    selectedImagePath?: string;
    selectedImageUrl?: string;
    refinementRequirement?: string;
  },
): Promise<StickerRecord> {
  const runId = randomUUID();
  await cleanupStaleRuntimeBlobs();
  const result = record.result
    ? {
        ...record.result,
        runId,
        candidates: [],
        candidateUrls: {},
        candidateErrors: {},
        requestedCandidateCount: config.imageGenerationCandidateCount,
        refinementRequirement: input.refinementRequirement,
        selectedPath: input.selectedImagePath ?? record.result.selectedPath,
      }
    : {
        provider: config.imageGenerationApiKey ? "gpt-image-2" as const : "placeholder" as const,
        format: record.format,
        runId,
        candidates: [],
        candidateUrls: {},
        candidateErrors: {},
        requestedCandidateCount: config.imageGenerationCandidateCount,
        refinementRequirement: input.refinementRequirement,
      };

  const generatingRecord = await updateStickerRecord(record.id, {
    status: "generating",
    error: undefined,
    result,
  });
  const referenceBody = input.referenceImageUrl ? await readRuntimeBlob(input.referenceImageUrl) : undefined;
  const referenceImageUrl = referenceBody
    ? await uploadRuntimeReferenceBlob(
        record.id,
        input.referenceImagePath ?? input.referenceImageUrl!,
        referenceBody,
        runId,
      )
    : input.referenceImageUrl;

  await writeCurrentRunBlob({ recordId: record.id, runId });
  await deleteRuntimeAssetsExceptCurrent({ recordId: record.id, runId });
  await sendGenerationRun({
    recordId: record.id,
    runId,
    mode: input.mode,
    count: config.imageGenerationCandidateCount,
    referenceImagePath: input.referenceImagePath,
    referenceImageUrl,
    selectedImagePath: input.selectedImagePath,
    selectedImageUrl: input.selectedImageUrl,
    refinementRequirement: input.refinementRequirement,
  });

  return generatingRecord;
}

function assertGeneratedPath(relativePath: string): string {
  const absolutePath = relativePath.startsWith(".runtime/generated/")
    ? path.resolve(runtimeGeneratedRoot, path.relative(".runtime/generated", relativePath))
    : path.resolve(projectRoot, relativePath);
  const isRuntimeGeneratedPath =
    absolutePath === runtimeGeneratedRoot || absolutePath.startsWith(`${runtimeGeneratedRoot}${path.sep}`);

  if (!isRuntimeGeneratedPath) {
    throw Object.assign(new Error("Selected image must be inside runtime generated storage"), { statusCode: 400 });
  }

  return absolutePath;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

function withoutCandidatePreviews(record: StickerRecord): StickerRecord {
  if (!record.result?.candidatePreviews) {
    return record;
  }

  const { candidatePreviews: _candidatePreviews, ...result } = record.result;

  return { ...record, result };
}

function assertNotionConfigured(): void {
  if (!config.notionToken || !config.notionDatabaseId) {
    throw Object.assign(new Error("Notion is not configured"), { statusCode: 500 });
  }
}

async function getAcceptedStickerPaths(record: Awaited<ReturnType<typeof getStickerRecord>>, selectedPath?: string) {
  if (!record) {
    throw new Error("Sticker record not found");
  }

  const sourcePath = selectedPath ?? record.result?.selectedPath ?? record.result?.localPath;

  if (!sourcePath) {
    throw Object.assign(new Error("No selected image to accept"), { statusCode: 400 });
  }

  const sourceAbsolutePath = assertGeneratedPath(sourcePath);
  const theme = slugify(record.theme);
  const extension = path.extname(sourceAbsolutePath) || ".png";
  const contentName = await getAvailableNotionContentName("generated", theme, slugify(record.description), extension);
  const motionName = path.parse(contentName).name;

  return {
    sourceAbsolutePath,
    finalPath: `data/generated/${theme}/${contentName}`,
    cachePath: `data/history/${theme}/${motionName}.json`,
  };
}

stickersRouter.post("/upload-reference", async (req, res, next) => {
  try {
    const input = uploadReferenceSchema.parse(req.body);
    const extension = path.extname(input.fileName).toLowerCase();
    const safeExtension = /\.(png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
    const safeName = `ref-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExtension}`;
    const base64 = input.data.includes(",") ? input.data.split(",", 2)[1] : input.data;
    const body = Buffer.from(base64, "base64");

    assertNotionConfigured();

    await mkdir(runtimeUploadsRoot, { recursive: true });

    const filePath = path.join(runtimeUploadsRoot, safeName);
    await writeFile(filePath, body);

    const relativePath = process.env.VERCEL
      ? `.runtime/uploads/${safeName}`
      : path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const themeSlug = slugify(input.theme);
    const descriptionSlug = slugify(input.description);
    const recordKey = input.recordId ?? `${themeSlug}-${descriptionSlug}`;
    const blobPathname = await uploadRuntimeReferenceBlob(recordKey, relativePath, body, input.runId);

    const contentName = await getAvailableNotionContentName("reference", themeSlug, descriptionSlug, safeExtension);
    const notionPageId = await uploadDataFolderFile({
      group: "reference",
      category: themeSlug,
      content: contentName,
      relativePath,
      absolutePath: filePath,
      data: body,
      sizeBytes: body.byteLength,
      updatedAt: new Date().toISOString(),
    });

    if (notionPageId === "notion-not-configured") {
      throw Object.assign(new Error("Notion is not configured"), { statusCode: 500 });
    }

    res.json({ path: relativePath, blobPathname, notionPageId });
  } catch (error) {
    next(error);
  }
});

stickersRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await listStickerRecords());
  } catch (error) {
    next(error);
  }
});

stickersRouter.post("/", async (req, res, next) => {
  try {
    const input = createStickerSchema.parse(req.body);
    const record = await createStickerRecord(input);
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});


function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

stickersRouter.get("/:id/preview/:index", async (req, res, next) => {
  try {
    const record = await getStickerRecord(req.params.id);

    if (!record || !record.result?.candidates?.length) {
      res.status(404).json({ error: "Sticker record or candidates not found" });
      return;
    }

    const candidateIndex = Number(req.params.index);
    const candidatePath = record.result.candidates[candidateIndex];
    if (!candidatePath) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    const candidateUrl = record.result.candidateUrls?.[candidatePath];
    if (candidateUrl) {
      const raw = await readRuntimeBlob(candidateUrl);

      if (raw) {
        res.set("Content-Type", getMimeType(candidatePath));
        res.set("Cache-Control", "private, max-age=300");
        res.send(raw);
        return;
      }
    }

    const absolutePath = candidatePath.startsWith(".runtime/generated/")
      ? path.join(runtimeGeneratedRoot, path.relative(".runtime/generated", candidatePath))
      : path.join(projectRoot, candidatePath);

    const raw = await readFile(absolutePath).catch(() => null);
    if (!raw) {
      res.status(404).json({ error: "Candidate file not found" });
      return;
    }

    res.set("Content-Type", getMimeType(candidatePath));
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(raw));
  } catch (error) {
    next(error);
  }
});

stickersRouter.get("/gallery", async (_req, res, next) => {
  try {
    const historyRecords = await listStickerRecords();
    const generatedPages = await listDataFolderRows("generated");

    const fileUrlByKey = new Map<string, string>();
    for (const page of generatedPages) {
      const fileUrl = getFilePropertyUrl(page, "File");
      const relativePath = getRichTextProperty(page, "Relative Path");
      const category = getRichTextProperty(page, "Category");
      const content = getRichTextProperty(page, "Content");
      if (fileUrl && relativePath) {
        fileUrlByKey.set(relativePath, fileUrl);
        const withoutExt = relativePath.replace(/\.[a-zA-Z0-9]+$/, "");
        fileUrlByKey.set(withoutExt, fileUrl);
      }
      if (fileUrl && category && content) {
        const key = `${category}/${content}`.replace(/\.[a-zA-Z0-9]+$/, "");
        fileUrlByKey.set(key, fileUrl);
      }
    }

    const galleryItems = historyRecords
      .filter((r) => r.status === "generated" || r.status === "accepted" || r.status === "uploaded" || r.status === "uploading")
      .map((r) => {
        const localPath = r.result?.localPath ?? "";
        const localPathNoExt = localPath.replace(/\.[a-zA-Z0-9]+$/, "");
        const notionUrl = localPath
          ? (fileUrlByKey.get(localPath) ?? fileUrlByKey.get(localPathNoExt))
          : undefined;
        return {
          id: r.id,
          theme: r.theme,
          description: r.description,
          status: r.status,
          imageUrl: notionUrl || null,
          localPath,
          createdAt: r.createdAt,
        };
      })
      .filter((item) => item.imageUrl !== null);

    res.json(galleryItems);
  } catch (error) {
    next(error);
  }
});

stickersRouter.get("/gallery/download", async (req, res, next) => {
  try {
    const url = req.query.url as string | undefined;
    if (!url) {
      res.status(400).json({ error: "url query param is required" });
      return;
    }
    const imageRes = await fetch(url);
    if (!imageRes.ok) {
      res.status(502).json({ error: "Failed to fetch image" });
      return;
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer());
    const contentType = imageRes.headers.get("content-type") ?? "image/png";
    const filename = (req.query.filename as string) || "sticker.png";
    res.set("Content-Type", contentType);
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.set("Content-Length", String(buffer.length));
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

stickersRouter.post("/gallery/remove", async (req, res, next) => {
  try {
    const { localPath } = req.body as { localPath?: string };
    if (!localPath) {
      res.status(400).json({ error: "localPath is required" });
      return;
    }

    const generatedPages = await listDataFolderRows("generated");
    const page = generatedPages.find((p) => getRichTextProperty(p, "Relative Path") === localPath);
    if (page) {
      await archiveNotionPage(page.id);
      res.json({ removed: true });
    } else {
      res.json({ removed: false, message: "Notion page not found for this path" });
    }
  } catch (error) {
    next(error);
  }
});

stickersRouter.get("/current", async (_req, res, next) => {
  try {
    const current = await readCurrentRunBlob();
    if (!current) {
      res.json({ record: null });
      return;
    }

    const record = await getStickerRecord(current.recordId);
    if (!record) {
      await clearCurrentRunBlob(current);
      res.json({ record: null });
      return;
    }

    if (record.result?.runId !== current.runId) {
      await clearCurrentRunBlob(current);
      res.json({ record: null });
      return;
    }

    if (record.status === "accepted" || record.status === "uploaded" || record.status === "rejected") {
      await clearCurrentRunBlob(current);
      res.json({ record: null });
      return;
    }

    res.json({ record: withoutCandidatePreviews(record) });
  } catch (error) {
    next(error);
  }
});

stickersRouter.get("/:id", async (req, res, next) => {
  try {
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    res.json(record);
  } catch (error) {
    next(error);
  }
});

stickersRouter.post("/:id/generate", async (req, res, next) => {
  try {
    const input = generateStickerInputSchema.parse(req.body ?? {});
    let record = await getStickerRecord(req.params.id);

    if (!record) {
      if (input.theme && input.description) {
        record = await createStickerRecord({ format: "svg", theme: input.theme, description: input.description });
      } else {
        res.status(404).json({ error: "Sticker record not found" });
        return;
      }
    }

    const routeStartedAt = Date.now();
    logStickerRouteStep("generate_request_accepted", { recordId: record.id, theme: record.theme });
    await deleteStickerRuntimeAssets(record.id);
    const generatingRecord = await enqueueGenerationRun(record, {
      mode: "generate",
      referenceImagePath: input.referenceImagePath,
      referenceImageUrl: input.referenceImageUrl,
    });
    logStickerRouteStep("generate_response_sent", { recordId: record.id, elapsedMs: Date.now() - routeStartedAt });
    res.status(202).json(withoutCandidatePreviews(generatingRecord));
  } catch (error) {
    logStickerRouteError("generate_failed", error, { recordId: req.params.id });
    next(error);
  }
});

stickersRouter.post("/:id/refine", async (req, res, next) => {
  try {
    const input = refineStickerSchema.parse(req.body);
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    assertGeneratedPath(input.selectedPath);

    const routeStartedAt = Date.now();
    logStickerRouteStep("refine_request_accepted", { recordId: record.id });
    const generatingRecord = await enqueueGenerationRun(record, {
      mode: "refine",
      selectedImagePath: input.selectedPath,
      selectedImageUrl: record.result?.candidateUrls?.[input.selectedPath],
      refinementRequirement: input.requirement,
      referenceImagePath: input.referenceImagePath,
      referenceImageUrl: input.referenceImageUrl,
    });
    logStickerRouteStep("refine_response_sent", { recordId: record.id, elapsedMs: Date.now() - routeStartedAt });
    res.status(202).json(withoutCandidatePreviews(generatingRecord));
  } catch (error) {
    logStickerRouteError("refine_failed", error, { recordId: req.params.id });
    next(error);
  }
});

stickersRouter.post("/:id/accept", async (req, res, next) => {
  try {
    const input = acceptStickerSchema.parse(req.body ?? {});
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    let sourceAbsolutePath: string;
    if (input.imageData) {
      const tmpDir = path.join(runtimeGeneratedRoot, "accepts");
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${record.id}_${Date.now()}.png`);
      const base64 = input.imageData.startsWith("data:") ? input.imageData.split(",", 2)[1] : input.imageData;
      await writeFile(tmpFile, Buffer.from(base64, "base64"));
      sourceAbsolutePath = tmpFile;
    } else if (input.selectedPath && record.result?.candidateUrls?.[input.selectedPath]) {
      const tmpDir = path.join(runtimeGeneratedRoot, "accepts");
      await mkdir(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${record.id}_${Date.now()}${path.extname(input.selectedPath) || ".png"}`);
      const body = await readRuntimeBlob(record.result.candidateUrls[input.selectedPath]);
      if (!body) {
        throw new Error("Could not fetch selected candidate from Blob");
      }
      await writeFile(tmpFile, body);
      sourceAbsolutePath = tmpFile;
    } else {
      const paths = await getAcceptedStickerPaths(record, input.selectedPath);
      sourceAbsolutePath = paths.sourceAbsolutePath;
    }

    const { finalPath, cachePath } = await getAcceptedStickerPaths(record, input.selectedPath);
    const accepted = await updateStickerRecord(record.id, {
      status: "uploading",
      cachePath,
      result: record.result
        ? { ...record.result, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath }
        : { provider: "gpt-image-2", format: record.format, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath },
    });
    const notionPageId = await uploadAcceptedStickerRecord(withoutCandidatePreviews(accepted), sourceAbsolutePath);
    const uploaded = await updateStickerRecord(accepted.id, {
      status: "uploaded",
      result: accepted.result ? { ...accepted.result, notionPageId } : { provider: "gpt-image-2", format: accepted.format, notionPageId },
    });

    await deleteStickerCache(uploaded.id);
    if (record.result?.runId) {
      await clearCurrentRunBlob({ recordId: record.id, runId: record.result.runId });
    }

    res.json({ uploaded: true, notionPageId, record: uploaded });
  } catch (error) {
    next(error);
  }
});

stickersRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const input = rejectStickerSchema.parse(req.body ?? {});
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    const rejected = await updateStickerRecord(record.id, { status: "rejected" });
    const notionPageId = await uploadRejectedStickerRun(withoutCandidatePreviews(rejected), input.reason?.trim() || undefined);

    await deleteStickerCache(rejected.id);
    if (record.result?.runId) {
      await clearCurrentRunBlob({ recordId: record.id, runId: record.result.runId });
    }

    res.json({ rejected: true, notionPageId });
  } catch (error) {
    next(error);
  }
});
