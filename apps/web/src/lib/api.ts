import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const streamRecoveryTimeoutMs = 12 * 60 * 1000;
const streamRecoveryPollMs = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    throw new Error(`Could not reach the sticker API at ${apiBaseUrl || "the Vite /api proxy"}. ${message}`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function createSticker(input: CreateStickerInput): Promise<StickerRecord> {
  return request<StickerRecord>("/api/stickers", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function uploadReferenceImage(
  fileName: string,
  data: string,
  theme: string,
  description: string,
  recordId?: string,
  runId?: string,
): Promise<{ path: string; blobPathname?: string; notionPageId: string }> {
  return request<{ path: string; blobPathname?: string; notionPageId: string }>("/api/stickers/upload-reference", {
    body: JSON.stringify({ fileName, data, theme, description, recordId, runId }),
    method: "POST",
  });
}

export function getSticker(id: string): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}`);
}

export function getCurrentSticker(): Promise<{ record: StickerRecord | null }> {
  return request<{ record: StickerRecord | null }>("/api/stickers/current");
}

function isGenerationInProgress(record: StickerRecord): boolean {
  return record.status === "pending" || record.status === "generating";
}

async function pollGeneratedSticker(id: string): Promise<StickerRecord> {
  const deadline = Date.now() + streamRecoveryTimeoutMs;

  while (Date.now() < deadline) {
    const record = await getSticker(id);

    if (record.status === "generated" && record.result?.candidates?.length) {
      return record;
    }

    if (!isGenerationInProgress(record)) {
      throw new Error(record.error ?? `Generation stopped with status ${record.status}`);
    }

    await wait(streamRecoveryPollMs);
  }

  throw new Error("Generation timed out while waiting for generated candidates. Check the server terminal logs for background_generation_* entries.");
}

function startGeneration(id: string, input?: { theme?: string; description?: string; referenceImagePath?: string; referenceImageUrl?: string }): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}/generate`, {
    method: "POST",
    body: input ? JSON.stringify(input) : undefined,
  });
}

export async function generateSticker(
  id: string,
  onProgress: (current: number, total: number, candidate: string, preview?: string) => void,
  input?: { theme?: string; description?: string; referenceImagePath?: string; referenceImageUrl?: string },
): Promise<StickerRecord> {
  onProgress(0, 5, "");
  return startGeneration(id, input);
}

export async function refineSticker(
  id: string,
  input: { selectedPath: string; requirement: string; referenceImagePath?: string; referenceImageUrl?: string },
  onProgress: (current: number, total: number, candidate: string, preview?: string) => void,
): Promise<StickerRecord> {
  onProgress(0, 5, "");
  return request<StickerRecord>(`/api/stickers/${id}/refine`, {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function rejectSticker(id: string, input?: { reason?: string }): Promise<{ rejected: true; notionPageId: string }> {
  return request<{ rejected: true; notionPageId: string }>(`/api/stickers/${id}/reject`, {
    body: JSON.stringify(input ?? {}),
    method: "POST",
  });
}

export function acceptSticker(id: string, input?: { selectedPath?: string; imageData?: string }): Promise<{ uploaded: true; notionPageId: string }> {
  return request<{ uploaded: true; notionPageId: string }>(`/api/stickers/${id}/accept`, {
    body: JSON.stringify(input ?? {}),
    method: "POST",
  });
}

export function listAllStickers(): Promise<StickerRecord[]> {
  return request<StickerRecord[]>("/api/stickers");
}

export interface GalleryItem {
  id: string;
  theme: string;
  description: string;
  status: string;
  imageUrl: string | null;
  localPath: string;
  createdAt: string;
}

export function listGallery(): Promise<GalleryItem[]> {
  return request<GalleryItem[]>("/api/stickers/gallery");
}

export function removeGalleryItem(localPath: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>("/api/stickers/gallery/remove", {
    method: "POST",
    body: JSON.stringify({ localPath }),
  });
}
