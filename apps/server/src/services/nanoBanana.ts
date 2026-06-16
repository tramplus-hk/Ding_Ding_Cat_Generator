import type { StickerRecord, StickerResult } from "@sticker-platform/shared";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const generatedRoot = path.join(projectRoot, "data/generated");

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function buildPlaceholderSvg(record: StickerRecord): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#fffaf2"/>
  <circle cx="256" cy="214" r="112" fill="#e56f3a" opacity="0.18"/>
  <text x="256" y="240" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#172033">${record.stickerContent}</text>
  <text x="256" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#657085">${record.type.toUpperCase()} placeholder</text>
</svg>
`;
}

export async function generateSticker(record: StickerRecord): Promise<StickerResult> {
  const generatedDirectory = path.join(generatedRoot, slugify(record.category), slugify(record.stickerContent));
  const fileName = record.type === "gif" ? "result.gif" : "result.svg";
  const absolutePath = path.join(generatedDirectory, fileName);

  await mkdir(generatedDirectory, { recursive: true });

  if (record.type === "gif") {
    await writeFile(absolutePath, "GIF placeholder: Nano Banana 2 integration pending.\n", "utf8");
  } else {
    await writeFile(absolutePath, buildPlaceholderSvg(record), "utf8");
  }

  return {
    provider: "nano-banana-2",
    format: record.type,
    localPath: path.relative(projectRoot, absolutePath),
  };
}
