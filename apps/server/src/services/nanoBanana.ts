import type { StickerRecord, StickerResult } from "@sticker-platform/shared";

export async function generateSticker(record: StickerRecord): Promise<StickerResult> {
  void record;

  return {
    provider: "nano-banana-2",
    format: record.type,
    localPath: undefined,
  };
}
