import { z } from "zod";

export const stickerTypeSchema = z.enum(["svg", "gif"]);

export const stickerStatusSchema = z.enum([
  "pending",
  "generating",
  "generated",
  "rejected",
  "failed",
  "accepted",
  "uploading",
  "uploaded",
  "upload_failed",
]);

export const createStickerSchema = z.object({
  type: stickerTypeSchema,
  theme: z.string().min(1),
  category: z.string().min(1),
  stickerContent: z.string().min(1),
  description: z.string().min(1),
});

export const stickerResultSchema = z.object({
  provider: z.literal("nano-banana-2"),
  format: stickerTypeSchema,
  localPath: z.string().optional(),
  notionPageId: z.string().optional(),
});

export const stickerRecordSchema = createStickerSchema.extend({
  id: z.string(),
  status: stickerStatusSchema,
  result: stickerResultSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StickerType = z.infer<typeof stickerTypeSchema>;
export type StickerStatus = z.infer<typeof stickerStatusSchema>;
export type CreateStickerInput = z.infer<typeof createStickerSchema>;
export type StickerResult = z.infer<typeof stickerResultSchema>;
export type StickerRecord = z.infer<typeof stickerRecordSchema>;
