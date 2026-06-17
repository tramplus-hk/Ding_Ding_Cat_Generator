import { z } from "zod";

export const stickerFormatSchema = z.enum(["svg", "gif"]);

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
  format: stickerFormatSchema,
  theme: z.string().min(1),
  description: z.string().min(1),
});

export const stickerResultSchema = z.object({
  provider: z.literal("nano-banana-2"),
  format: stickerFormatSchema,
  localPath: z.string().optional(),
  fileUrl: z.string().optional(),
  selectedPath: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  candidateUrls: z.record(z.string()).optional(),
  candidatePreviews: z.record(z.string()).optional(),
  refinementRequirement: z.string().optional(),
  notionPageId: z.string().optional(),
});

export const stickerRecordSchema = createStickerSchema.extend({
  id: z.string(),
  status: stickerStatusSchema,
  cachePath: z.string().optional(),
  result: stickerResultSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StickerFormat = z.infer<typeof stickerFormatSchema>;
export type StickerStatus = z.infer<typeof stickerStatusSchema>;
export type CreateStickerInput = z.infer<typeof createStickerSchema>;
export type StickerResult = z.infer<typeof stickerResultSchema>;
export type StickerRecord = z.infer<typeof stickerRecordSchema>;
