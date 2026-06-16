import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

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

export function listStickers(): Promise<StickerRecord[]> {
  return request<StickerRecord[]>("/api/stickers");
}

export function createSticker(input: CreateStickerInput): Promise<StickerRecord> {
  return request<StickerRecord>("/api/stickers", {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function getSticker(id: string): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}`);
}

export function generateSticker(id: string): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}/generate`, { method: "POST" });
}

export function refineSticker(id: string, input: { selectedPath: string; requirement: string }): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}/refine`, {
    body: JSON.stringify(input),
    method: "POST",
  });
}

export function rejectSticker(id: string): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}/reject`, { method: "POST" });
}

export function acceptSticker(id: string, input?: { selectedPath?: string }): Promise<{ uploaded: true; notionPageId: string }> {
  return request<{ uploaded: true; notionPageId: string }>(`/api/stickers/${id}/accept`, {
    body: JSON.stringify(input ?? {}),
    method: "POST",
  });
}
