import type { Response } from "express";
import { createStickerSchema } from "@sticker-platform/shared";
import { Router } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateSticker } from "../services/nanoBanana.js";
import { getAvailableNotionContentName, uploadAcceptedStickerRecord, uploadDataFolderFile, uploadRejectedStickerRun } from "../services/notion.js";
import {
  createStickerRecord,
  deleteStickerCache,
  getStickerRecord,
  listStickerRecords,
  updateStickerRecord,
} from "../services/stickerStorage.js";

function writeSSE(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendSSEError(res: Response, message: string): void {
  writeSSE(res, { type: "error", message });
  res.end();
}

export const stickersRouter = Router();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeGeneratedRoot = path.join(projectRoot, ".runtime/generated");
const uploadsDir = path.join(projectRoot, ".runtime/uploads");

export const uploadReferenceSchema = z.object({
  fileName: z.string().min(1),
  data: z.string().min(1),
  theme: z.string().min(1),
  description: z.string().min(1),
});

const refineStickerSchema = z.object({
  selectedPath: z.string().min(1),
  requirement: z.string().min(1),
  referenceImagePath: z.string().optional(),
});

const acceptStickerSchema = z.object({
  selectedPath: z.string().min(1).optional(),
});

const rejectStickerSchema = z.object({
  reason: z.string().optional(),
});

function assertGeneratedPath(relativePath: string): string {
  const absolutePath = path.resolve(projectRoot, relativePath);
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
    const { fileName, data, theme, description } = uploadReferenceSchema.parse(req.body);
    const extension = path.extname(fileName).toLowerCase();
    const safeExtension = /\.(png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
    const safeName = `ref-${Date.now()}${safeExtension}`;

    await mkdir(uploadsDir, { recursive: true });

    const base64 = data.includes(",") ? data.split(",")[1] : data;
    const filePath = path.join(uploadsDir, safeName);
    await writeFile(filePath, Buffer.from(base64, "base64"));

    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const themeSlug = slugify(theme);
    const descriptionSlug = slugify(description);
    const contentName = await getAvailableNotionContentName("reference", themeSlug, descriptionSlug, safeExtension);

    try {
      await uploadDataFolderFile({
        group: "reference",
        category: themeSlug,
        content: contentName,
        relativePath,
        absolutePath: filePath,
        sizeBytes: Buffer.byteLength(base64, "base64"),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Notion upload is best-effort for reference images
    }

    res.json({ path: relativePath });
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
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    const referenceImagePath: string | undefined =
      typeof req.body?.referenceImagePath === "string" && req.body.referenceImagePath.length > 0
        ? req.body.referenceImagePath
        : undefined;

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await updateStickerRecord(record.id, { status: "generating" });
    const result = await generateSticker(record, {
      count: 5,
      referenceImagePath,
      onProgress: (current, total, candidatePath) => {
        writeSSE(res, { type: "progress", current, total, candidate: candidatePath });
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

    await updateStickerRecord(record.id, {
      status: "generating",
      result: record.result ? { ...record.result, selectedPath: input.selectedPath } : undefined,
    });
    const result = await generateSticker(record, {
      count: 5,
      selectedImagePath: input.selectedPath,
      refinementRequirement: input.requirement,
      referenceImagePath: input.referenceImagePath,
      onProgress: (current, total, candidatePath) => {
        writeSSE(res, { type: "progress", current, total, candidate: candidatePath });
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

    const { sourceAbsolutePath, finalPath, cachePath } = await getAcceptedStickerPaths(record, input.selectedPath);
    const accepted = await updateStickerRecord(record.id, {
      status: "uploading",
      cachePath,
      result: record.result
        ? { ...record.result, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath }
        : { provider: "nano-banana-2", format: record.format, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath },
    });
    const notionPageId = await uploadAcceptedStickerRecord(accepted, sourceAbsolutePath);
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
    const notionPageId = await uploadRejectedStickerRun(rejected, input.reason?.trim() || undefined);

    await deleteStickerCache(rejected.id);

    res.json({ rejected: true, notionPageId });
  } catch (error) {
    next(error);
  }
});
