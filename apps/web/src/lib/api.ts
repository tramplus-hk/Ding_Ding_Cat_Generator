import type { CreateStickerInput, StickerRecord } from "@sticker-platform/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const streamRecoveryTimeoutMs = 12 * 60 * 1000;
const streamRecoveryPollMs = 2_000;

class StreamDisconnectedError extends Error {}

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
): Promise<{ path: string; blobPathname?: string; notionPageId: string }> {
  return request<{ path: string; blobPathname?: string; notionPageId: string }>("/api/stickers/upload-reference", {
    body: JSON.stringify({ fileName, data, theme, description }),
    method: "POST",
  });
}

export function getSticker(id: string): Promise<StickerRecord> {
  return request<StickerRecord>(`/api/stickers/${id}`);
}

async function pollGeneratedSticker(id: string, originalError: unknown): Promise<StickerRecord> {
  const deadline = Date.now() + streamRecoveryTimeoutMs;

  while (Date.now() < deadline) {
    const record = await getSticker(id);

    if (record.status === "generated" && record.result?.candidates?.length) {
      return record;
    }

    if (record.status === "generating") {
      await wait(streamRecoveryPollMs);
      continue;
    }

    break;
  }

  throw originalError;
}

type SSEServerEvent =
  | { type: "progress"; current: number; total: number; candidate: string; preview?: string }
  | { type: "done"; record: StickerRecord }
  | { type: "error"; message: string };

async function streamRequest<T>(
  path: string,
  options: RequestInit,
  onProgress: (current: number, total: number, candidate: string, preview?: string) => void,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    throw new Error(`Could not reach the sticker API at ${apiBaseUrl || "the Vite /api proxy"} for streaming sticker API request. ${message}`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Response body is not readable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown stream read error";
      throw new StreamDisconnectedError(`Live generation progress stream disconnected while reading server-sent events from ${apiBaseUrl || "the Vite /api proxy"}. This is a browser-to-backend progress stream error, not proof that the image model failed. original browser stream error: ${message}`);
    }

    const { done, value } = chunk;
    if (done) {
      throw new Error("Stream ended without done event");
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as SSEServerEvent;
      if (event.type === "progress") {
        onProgress(event.current, event.total, event.candidate, event.preview);
      } else if (event.type === "done") {
        return event.record as T;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  }
}

export function generateSticker(
  id: string,
  onProgress: (current: number, total: number, candidate: string, preview?: string) => void,
  input?: { theme?: string; description?: string; referenceImagePath?: string; referenceImageUrl?: string },
): Promise<StickerRecord> {
  return streamRequest<StickerRecord>(`/api/stickers/${id}/generate`, {
    method: "POST",
    body: input ? JSON.stringify(input) : undefined,
  }, onProgress).catch(async (error) => {
    if (error instanceof StreamDisconnectedError) {
      return pollGeneratedSticker(id, error);
    }

    const record = await getSticker(id);

    if (record.status === "generated" && record.result?.candidates?.length) {
      return record;
    }

    throw error;
  });
}

export function refineSticker(
  id: string,
  input: { selectedPath: string; requirement: string; referenceImagePath?: string; referenceImageUrl?: string },
  onProgress: (current: number, total: number, candidate: string, preview?: string) => void,
): Promise<StickerRecord> {
  return streamRequest<StickerRecord>(
    `/api/stickers/${id}/refine`,
    { body: JSON.stringify(input), method: "POST" },
    onProgress,
  ).catch(async (error) => {
    if (error instanceof StreamDisconnectedError) {
      return pollGeneratedSticker(id, error);
    }

    const record = await getSticker(id);

    if (record.status === "generated" && record.result?.candidates?.length) {
      return record;
    }

    throw error;
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
