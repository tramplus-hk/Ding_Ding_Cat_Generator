import { createStickerSchema } from "@sticker-platform/shared";
import { Router } from "express";
import { generateSticker } from "../services/nanoBanana.js";
import { uploadFinalStickerJson } from "../services/notion.js";
import {
  createStickerRecord,
  deleteStickerCache,
  getStickerRecord,
  listStickerRecords,
  updateStickerRecord,
} from "../services/stickerStorage.js";

export const stickersRouter = Router();

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
    const result = await generateSticker(record);
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
    const record = await getStickerRecord(req.params.id);

    if (!record) {
      res.status(404).json({ error: "Sticker record not found" });
      return;
    }

    const accepted = await updateStickerRecord(record.id, { status: "uploading" });
    const notionPageId = await uploadFinalStickerJson(accepted);
    const uploaded = await updateStickerRecord(record.id, {
      status: "uploaded",
      result: accepted.result
        ? { ...accepted.result, notionPageId }
        : { provider: "nano-banana-2", format: accepted.type, notionPageId },
    });

    await deleteStickerCache(uploaded.id);
    res.json({ uploaded: true, notionPageId });
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
