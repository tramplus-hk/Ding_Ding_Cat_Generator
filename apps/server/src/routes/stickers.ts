import type { Response } from "express";
import { createStickerSchema } from "@sticker-platform/shared";
import { Router } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../config.js";
import { generateSticker } from "../services/nanoBanana.js";
import { getAvailableNotionContentName, uploadAcceptedStickerRecord, uploadDataFolderFile, uploadRejectedStickerRun } from "../services/notion.js";
import {
  createStickerRecord,
  deleteStickerCache,
  deleteStickerRuntimeAssets,
  getStickerRecord,
  listStickerRecords,
  updateStickerRecord,
} from "../services/stickerStorage.js";
import { readRuntimeBlob, uploadRuntimeReferenceBlob } from "../services/runtimeBlob.js";

type StickerRecord = Awaited<ReturnType<typeof getStickerRecord>> extends infer T ? NonNullable<T> : never;

function writeSSE(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendSSEError(res: Response, message: string): void {
  writeSSE(res, { type: "error", message });
  res.end();
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
    const recordKey = `${themeSlug}-${descriptionSlug}`;
    const blobPathname = await uploadRuntimeReferenceBlob(recordKey, relativePath, body);

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

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await deleteStickerRuntimeAssets(record.id);
    await updateStickerRecord(record.id, { status: "generating" });
    const result = await generateSticker(record, {
      count: 5,
      referenceImagePath: input.referenceImagePath,
      referenceImageUrl: input.referenceImageUrl,
      onProgress: (current, total, candidatePath, preview) => {
        writeSSE(res, { type: "progress", current, total, candidate: candidatePath, preview });
      },
    });
    const updated = await updateStickerRecord(record.id, {
      status: "generated",
      result,
    });

    writeSSE(res, { type: "done", record: updated });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      const message = error instanceof Error ? error.message : "Generation failed";
      sendSSEError(res, message);
    } else {
      next(error);
    }
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

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await deleteStickerRuntimeAssets(record.id);
    await updateStickerRecord(record.id, {
      status: "generating",
      result: record.result ? { ...record.result, selectedPath: input.selectedPath } : undefined,
    });
    const result = await generateSticker(record, {
      count: 5,
      selectedImagePath: input.selectedPath,
      selectedImageUrl: record.result?.candidateUrls?.[input.selectedPath],
      refinementRequirement: input.requirement,
      referenceImagePath: input.referenceImagePath,
      referenceImageUrl: input.referenceImageUrl,
      onProgress: (current, total, candidatePath, preview) => {
        writeSSE(res, { type: "progress", current, total, candidate: candidatePath, preview });
      },
    });
    const updated = await updateStickerRecord(record.id, {
      status: "generated",
      result,
    });

    writeSSE(res, { type: "done", record: updated });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      const message = error instanceof Error ? error.message : "Refinement failed";
      sendSSEError(res, message);
    } else {
      next(error);
    }
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
        : { provider: "nano-banana-2", format: record.format, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath },
    });
    const notionPageId = await uploadAcceptedStickerRecord(withoutCandidatePreviews(accepted), sourceAbsolutePath);
    const uploaded = await updateStickerRecord(accepted.id, {
      status: "uploaded",
      result: accepted.result ? { ...accepted.result, notionPageId } : { provider: "nano-banana-2", format: accepted.format, notionPageId },
    });

    await deleteStickerCache(uploaded.id);

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

    res.json({ rejected: true, notionPageId });
  } catch (error) {
    next(error);
  }
});
