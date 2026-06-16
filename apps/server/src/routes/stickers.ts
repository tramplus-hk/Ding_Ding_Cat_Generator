import { createStickerSchema } from "@sticker-platform/shared";
import { Router } from "express";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateSticker } from "../services/nanoBanana.js";
import { uploadFinalStickerJson } from "../services/notion.js";
import {
  createStickerRecord,
  deleteStickerCache,
  getStickerRecord,
  listStickerRecords,
  persistStickerRecord,
  updateStickerRecord,
} from "../services/stickerStorage.js";

export const stickersRouter = Router();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const generatedRoot = path.join(projectRoot, "data/generated");
const runtimeGeneratedRoot = path.join(projectRoot, ".runtime/generated");

const refineStickerSchema = z.object({
  selectedPath: z.string().min(1),
  requirement: z.string().min(1),
});

const acceptStickerSchema = z.object({
  selectedPath: z.string().min(1).optional(),
});

function assertGeneratedPath(relativePath: string): string {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const isGeneratedPath = absolutePath === generatedRoot || absolutePath.startsWith(`${generatedRoot}${path.sep}`);
  const isRuntimeGeneratedPath =
    absolutePath === runtimeGeneratedRoot || absolutePath.startsWith(`${runtimeGeneratedRoot}${path.sep}`);

  if (!isGeneratedPath && !isRuntimeGeneratedPath) {
    throw Object.assign(new Error("Selected image must be inside generated storage"), { statusCode: 400 });
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

async function copySelectedToFinal(record: Awaited<ReturnType<typeof getStickerRecord>>, selectedPath?: string) {
  if (!record) {
    throw new Error("Sticker record not found");
  }

  const sourcePath = selectedPath ?? record.result?.selectedPath ?? record.result?.localPath;

  if (!sourcePath) {
    throw Object.assign(new Error("No selected image to accept"), { statusCode: 400 });
  }

  const sourceAbsolutePath = assertGeneratedPath(sourcePath);
  const extension = path.extname(sourceAbsolutePath) || ".png";
  const finalDirectory = path.join(generatedRoot, slugify(record.theme));
  const finalAbsolutePath = await getAvailableGeneratedImagePath(finalDirectory, slugify(record.description), extension);

  await mkdir(finalDirectory, { recursive: true });
  await copyFile(sourceAbsolutePath, finalAbsolutePath);

  return path.relative(projectRoot, finalAbsolutePath);
}

async function getAvailableGeneratedImagePath(directory: string, baseName: string, extension: string): Promise<string> {
  const entries = await readdir(directory).catch(() => []);
  const usedNames = new Set(entries.map((entry) => path.parse(entry).name));
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? baseName : `${baseName}_${index}`;

    if (!usedNames.has(candidateName)) {
      return path.join(directory, `${candidateName}${extension}`);
    }

    index += 1;
  }
}

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

    await updateStickerRecord(record.id, { status: "generating" });
    const result = await generateSticker(record, { count: 5 });
    const updated = await updateStickerRecord(record.id, {
      status: "generated",
      result,
    });

    res.json(updated);
  } catch (error) {
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
    await updateStickerRecord(record.id, {
      status: "generating",
      result: record.result ? { ...record.result, selectedPath: input.selectedPath } : undefined,
    });
    const result = await generateSticker(record, {
      count: 5,
      selectedImagePath: input.selectedPath,
      refinementRequirement: input.requirement,
    });
    const updated = await updateStickerRecord(record.id, {
      status: "generated",
      result,
    });

    res.json(updated);
  } catch (error) {
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

    const finalPath = await copySelectedToFinal(record, input.selectedPath);
    const accepted = await updateStickerRecord(record.id, {
      status: "uploading",
      result: record.result
        ? { ...record.result, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath }
        : { provider: "nano-banana-2", format: record.format, localPath: finalPath, fileUrl: `/${finalPath.replace(/^data\//, "")}`, selectedPath: finalPath },
    });
    const persistedAccepted = await persistStickerRecord(accepted.id);
    const notionPageId = await uploadFinalStickerJson(persistedAccepted);
    const uploaded = await updateStickerRecord(persistedAccepted.id, {
      status: "uploaded",
      result: persistedAccepted.result
        ? { ...persistedAccepted.result, notionPageId }
        : { provider: "nano-banana-2", format: persistedAccepted.format, notionPageId },
    });

    res.json({ uploaded: true, notionPageId, record: uploaded });
  } catch (error) {
    next(error);
  }
});

stickersRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const updated = await updateStickerRecord(req.params.id, { status: "rejected" });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});
