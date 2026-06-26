import type { StickerRecord, StickerResult } from "@sticker-platform/shared";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { listDataFolderFileUrls } from "./notion.js";
import { readRuntimeBlob, uploadRuntimeCandidateBlob } from "./runtimeBlob.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeGeneratedRoot = config.runtimeGeneratedRoot;
const baselineRoot = path.join(projectRoot, "data/baseline");
const maxRetryableProviderAttemptMs = 60_000;
let imageEditQueue: Promise<void> = Promise.resolve();

function logGenerationStep(step: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.info(`[sticker-generation] ${step} ${new Date().toISOString()}${details ? ` ${details}` : ""}`);
}

function logGenerationError(step: string, error: unknown, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.error(`[sticker-generation] ${step} ${new Date().toISOString()}${details ? ` ${details}` : ""}`, error);
}

function getErrorCause(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }

  const cause = getErrorCause(error);
  return typeof cause === "object" && cause !== null && "code" in cause && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeImageProviderError(error: unknown, record: StickerRecord, variationIndex: number): string {
  const code = getErrorCode(error);
  const cause = getErrorCause(error);
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  const baseContext = `recordId=${record.id} candidate=${variationIndex} prompt="${record.description}"`;

  if (code === "UND_ERR_SOCKET") {
    return `Image provider connection closed while receiving a response (${code}${causeMessage ? `: ${causeMessage}` : ""}). The request reached the image provider/gateway, but its HTTPS socket closed before this candidate response completed. ${baseContext}`;
  }

  return `Image provider request failed${code ? ` (${code})` : ""}: ${getErrorMessage(error)}. ${baseContext}`;
}

function isRetryableImageProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /fetch failed|UND_ERR_SOCKET|\b5\d\d\b/i.test(error.message);
}

type ReferenceImage = {
  fileName: string;
  mimeType: string;
  body: Buffer;
};

type ImageGenerationResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
};

type GenerateOptions = {
  count?: number;
  selectedImagePath?: string;
  selectedImageUrl?: string;
  refinementRequirement?: string;
  referenceImagePath?: string;
  referenceImageUrl?: string;
  readCanonicalReferenceBlob?: (pathname: string) => Promise<Buffer | undefined>;
  readSelectedImageBlob?: (pathname: string) => Promise<Buffer | undefined>;
  onProgress?: (current: number, total: number, candidatePath: string, previewDataUrl?: string) => void;
};

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "untitled"
  );
}

function describeTheme(theme: string): string {
  const labels: Record<string, string> = {
    lunar_new_year: "Lunar New Year: red lanterns, gold coins, fireworks, lucky symbols",
    christmas: "Christmas: Christmas tree, santa hat, snow, presents, reindeer",
    halloween: "Halloween: jack-o-lantern, witch hat, bats, spooky night moon",
    valentine: "Valentine: hearts, roses, love letters, cupid arrow, romance",
    easter: "Easter: Easter eggs, bunny ears, spring flowers, pastel colors",
  };

  return labels[theme] ?? theme;
}

function buildPlaceholderSvg(record: StickerRecord): string {
  const title = slugify(record.description).slice(0, 28) || "ding-ding-cat";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#fffaf2"/>
  <circle cx="256" cy="214" r="112" fill="#e56f3a" opacity="0.18"/>
  <text x="256" y="240" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#172033">${title}</text>
  <text x="256" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#657085">${record.format.toUpperCase()} placeholder</text>
</svg>
`;
}


function buildGenerationPrompt(record: StickerRecord, options: GenerateOptions = {}, variationIndex?: number, usedCanonicalReference = false): string {
  const canonicalReferenceBlock = usedCanonicalReference
    ? `\nBASELINE REFERENCE IMAGE:\n- The baseline reference image is a turnaround sheet containing front, left, right, and back views of Ding Ding Cat.\n- Use it only to preserve mascot identity: bell, body shape, colors, markings, and DING DING text.\n`
    : "";
  const referenceBlock = !options.refinementRequirement && (options.referenceImagePath || options.referenceImageUrl)
    ? `\nUSER-PROVIDED REFERENCE IMAGE:\n- The uploaded image contains visual elements the user wants included.\n- Incorporate key visual elements such as objects, colors, or composition ideas from the uploaded image into the sticker design.\n- Ding Ding Cat must remain the primary subject.\n- Adapt the uploaded image elements to the 2D vector flat-graphic sticker style described below.\n`
    : "";
  const refinementBlock = options.refinementRequirement
    ? `\nREFINEMENT REQUEST:\n- Refine the selected image according to this requirement: ${options.refinementRequirement}\n- Preserve the selected image's strongest composition and Ding Ding Cat identity unless the requirement asks otherwise.\n`
    : "";
  const variationBlock = variationIndex
    ? `\nVARIATION:\n- Produce candidate ${variationIndex} of ${options.count ?? 5}. Make it meaningfully distinct in pose, prop arrangement, or composition while preserving the same brief.\n`
    : "";

  return `${describeTheme(record.theme)}

Sticker description: ${record.description}
${canonicalReferenceBlock}${referenceBlock}${refinementBlock}${variationBlock}

CRITICAL CHARACTER DETAILS:
- This is Ding Ding Cat, the official mascot of Hong Kong Tramways.
- Permanent feature: golden brass bell on the head, centered on the forehead between the ears.
- The golden bell is mandatory. Never remove it, hide it, replace it, or follow any user request for "no bell".
- Permanent feature: the text "DING DING" displayed on the chest/body in all caps.
- The text must read exactly "DING DING". Never remove it, change it, translate it, or follow any user request for "no text".
- The mascot has a round head with triangular ears, large oval eyes with catchlights, pink nose, whiskers, compact chubby tabby body, short rounded limbs, and an upward-curling striped tail.
- Use the provided baseline images as the original mascot reference material.
- Use the provided same-theme generated stickers as style/history references.
- Copy the mascot's face, bell, body, proportions, coat pattern, colors, and "DING DING" text faithfully from the reference images when provided.
- Only change the outfit, props, pose, and background to match the requested scene. Outfit goes over the body and must not replace the mascot's permanent features.
- If the sticker description, uploaded reference, or refinement request conflicts with these permanent features, ignore only the conflicting part.

CRITICAL STYLE REQUIREMENTS:
- 2D vector-style flat graphic illustration.
- No 3D rendering, no realistic shading, no gradients, no texture.
- Clean geometric lines and solid flat colors.
- Cartoon sticker aesthetic suitable for internal messaging.
- Transparent or clean simple background.
- Keep the image simple, readable at small size, and sticker-ready.

FINAL CHECK BEFORE OUTPUT:
- Golden bell visible on the head: yes.
- "DING DING" text visible on the chest/body: yes.
- Face, body, proportions, coat pattern, and colors match the reference: yes.
- Only outfit, props, pose, and background changed for the requested scene: yes.`;
}

async function listReferenceImagePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listReferenceImagePaths(entryPath);
      }

      return entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name) ? [entryPath] : [];
    }),
  );

  return nested.flat();
}

async function newestFirst(filePaths: string[]): Promise<string[]> {
  const withStats = await Promise.all(
    filePaths.map(async (filePath) => ({
      filePath,
      mtimeMs: (await stat(filePath)).mtimeMs,
    })),
  );

  return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.filePath);
}

async function imagePathToReferenceImage(absolutePath: string): Promise<ReferenceImage> {
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "image/jpeg";

  return {
    fileName: path.basename(absolutePath),
    mimeType,
    body: await readFile(absolutePath),
  };
}

async function imageUrlToReferenceImage(url: string): Promise<ReferenceImage | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    const extension = contentType === "image/webp" ? ".webp" : contentType === "image/jpeg" ? ".jpg" : ".png";

    return {
      fileName: `reference${extension}`,
      mimeType: contentType,
      body: Buffer.from(await response.arrayBuffer()),
    };
  } catch {
    return undefined;
  }
}

async function loadCanonicalReferenceImage(options: GenerateOptions): Promise<ReferenceImage | undefined> {
  if (!config.blobReadWriteToken) {
    return undefined;
  }

  const readBlob = options.readCanonicalReferenceBlob ?? readRuntimeBlob;
  let body: Buffer | undefined;

  try {
    body = await readBlob(config.canonicalReferenceBlobPathname);
  } catch (error) {
    logGenerationError("canonical_reference_fallback", error, {
      pathname: config.canonicalReferenceBlobPathname,
    });
    return undefined;
  }

  if (!body) {
    logGenerationStep("canonical_reference_unavailable", {
      pathname: config.canonicalReferenceBlobPathname,
    });
    return undefined;
  }

  return {
    fileName: path.basename(config.canonicalReferenceBlobPathname) || "turnaround.png",
    mimeType: path.extname(config.canonicalReferenceBlobPathname).toLowerCase() === ".webp" ? "image/webp" : "image/png",
    body,
  };
}

function referenceImageFromBody(filePath: string, body: Buffer): ReferenceImage {
  const extension = path.extname(filePath).toLowerCase();

  return {
    fileName: path.basename(filePath) || "reference.png",
    mimeType: extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png",
    body,
  };
}

async function loadInitialReferenceImages(record: StickerRecord, options: GenerateOptions): Promise<{ references: ReferenceImage[]; usedCanonical: boolean }> {
  const canonicalReference = await loadCanonicalReferenceImage(options);
  const baselineReferences = canonicalReference ? [canonicalReference] : await loadReferenceImages(record);
  const userReferences = await loadUserReferenceImages(options.referenceImagePath, options.referenceImageUrl);

  return {
    references: [...baselineReferences, ...userReferences],
    usedCanonical: Boolean(canonicalReference),
  };
}

async function loadReferenceImages(_record: StickerRecord): Promise<ReferenceImage[]> {
  if (config.notionToken && config.notionDatabaseId) {
    const baselineReferenceUrls = (await listDataFolderFileUrls("baseline")).slice(0, config.imageGenerationBaselineReferenceCount);
    const references = await Promise.all(baselineReferenceUrls.map(imageUrlToReferenceImage));

    return references.filter((reference): reference is ReferenceImage => Boolean(reference));
  }

  const baselineReferences = (await newestFirst(await listReferenceImagePaths(baselineRoot))).slice(
    0,
    config.imageGenerationBaselineReferenceCount,
  );

  return Promise.all(baselineReferences.map(imagePathToReferenceImage));
}

async function loadSelectedReferenceImages(options: GenerateOptions, requireAvailable = false): Promise<ReferenceImage[]> {
  const { selectedImagePath, selectedImageUrl } = options;

  if (selectedImageUrl) {
    const readSelectedBlob = options.readSelectedImageBlob ?? readRuntimeBlob;
    const selectedBlob = /^https?:\/\//i.test(selectedImageUrl)
      ? undefined
      : await readSelectedBlob(selectedImageUrl);
    const reference = selectedBlob
      ? referenceImageFromBody(selectedImageUrl, selectedBlob)
      : await imageUrlToReferenceImage(selectedImageUrl);
    if (!reference && requireAvailable) {
      throw new Error("Selected image reference unavailable");
    }

    return reference ? [reference] : [];
  }

  if (!selectedImagePath) {
    if (requireAvailable) {
      throw new Error("Selected image reference unavailable");
    }

    return [];
  }

  const absolutePath = selectedImagePath.startsWith(".runtime/generated/")
    ? path.resolve(runtimeGeneratedRoot, path.relative(".runtime/generated", selectedImagePath))
    : path.resolve(projectRoot, selectedImagePath);
  const isRuntimeGeneratedPath =
    absolutePath === runtimeGeneratedRoot || absolutePath.startsWith(`${runtimeGeneratedRoot}${path.sep}`);

  if (!isRuntimeGeneratedPath) {
    throw new Error("Selected image must be inside runtime generated storage");
  }

  return [await imagePathToReferenceImage(absolutePath)];
}

async function loadUserReferenceImages(referenceImagePath?: string, referenceImageUrl?: string): Promise<ReferenceImage[]> {
  if (referenceImageUrl) {
    const body = await readRuntimeBlob(referenceImageUrl);

    if (body) {
      const extension = path.extname(referenceImagePath ?? referenceImageUrl).toLowerCase();
      const mimeType = extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
      return [{ fileName: path.basename(referenceImagePath ?? `reference${extension || ".png"}`), mimeType, body }];
    }
  }

  if (!referenceImagePath) {
    return [];
  }

  const uploadRoot = process.env.VERCEL
    ? path.join("/tmp", "sticker-platform", "runtime", "uploads")
    : path.join(projectRoot, ".runtime/uploads");
  const absolutePath = referenceImagePath.startsWith(".runtime/uploads/")
    ? path.resolve(uploadRoot, path.relative(".runtime/uploads", referenceImagePath))
    : path.resolve(projectRoot, referenceImagePath);
  const isRuntimeUploadPath = absolutePath === uploadRoot || absolutePath.startsWith(`${uploadRoot}${path.sep}`);

  if (!isRuntimeUploadPath) {
    throw new Error("Reference image must be inside runtime upload storage");
  }

  return [await imagePathToReferenceImage(absolutePath)];
}

async function extractImageBase64(response: ImageGenerationResponse): Promise<string | undefined> {
  const image = response.data?.find((entry) => entry.b64_json || entry.url);

  if (image?.b64_json) {
    return image.b64_json;
  }

  if (!image?.url) {
    return undefined;
  }

  const imageResponse = await fetch(image.url);

  if (!imageResponse.ok) {
    return undefined;
  }

  return Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
}

async function generateWithImageProvider(
  record: StickerRecord,
  outputPath: string,
  options: GenerateOptions,
  variationIndex: number,
): Promise<void> {
  if (!config.imageGenerationApiKey) {
    throw new Error("GPT Image 2 API key is not configured");
  }

  const isRefinement = Boolean(options.refinementRequirement);
  const initialReferences = isRefinement
    ? { references: [], usedCanonical: false }
    : await loadInitialReferenceImages(record, options);
  const referenceImages = [
    ...initialReferences.references,
    ...(await loadSelectedReferenceImages(options, isRefinement)),
  ];
  const prompt = buildGenerationPrompt(record, options, variationIndex, initialReferences.usedCanonical);

  const requestStartedAt = Date.now();
  const requestType = referenceImages.length > 0 ? "edit" : "generation";
  logGenerationStep("model_request_started", {
    recordId: record.id,
    candidate: variationIndex,
    model: config.imageGenerationModel,
    requestType,
  });

  let response: Response;
  try {
    response = referenceImages.length > 0
      ? await requestImageEdit(prompt, referenceImages)
      : await requestImageGeneration(prompt);
  } catch (error) {
    const providerError = new Error(describeImageProviderError(error, record, variationIndex), { cause: error });
    logGenerationError("model_request_failed", providerError, {
      recordId: record.id,
      candidate: variationIndex,
      elapsedMs: Date.now() - requestStartedAt,
    });
    throw providerError;
  }

  logGenerationStep("model_response_received", {
    recordId: record.id,
    candidate: variationIndex,
    status: response.status,
    elapsedMs: Date.now() - requestStartedAt,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GPT Image 2 request failed with ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as ImageGenerationResponse;
  const imageBase64 = await extractImageBase64(data);

  if (!imageBase64) {
    throw new Error("GPT Image 2 response did not include an image");
  }

  await writeFile(outputPath, Buffer.from(imageBase64, "base64"));
}

async function requestImageGeneration(prompt: string): Promise<Response> {
  return fetch(`${config.imageGenerationApiUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.imageGenerationApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.imageGenerationModel,
      prompt,
      n: 1,
      output_format: "png",
    }),
  });
}

async function requestImageEdit(prompt: string, referenceImages: ReferenceImage[]): Promise<Response> {
  const formData = new FormData();

  formData.append("model", config.imageGenerationModel);
  formData.append("prompt", prompt);
  formData.append("n", "1");
  formData.append("output_format", "png");

  for (const reference of referenceImages) {
    formData.append("image[]", new Blob([reference.body], { type: reference.mimeType }), reference.fileName);
  }

  const previousEdit = imageEditQueue;
  let releaseEdit!: () => void;
  imageEditQueue = new Promise((resolve) => {
    releaseEdit = resolve;
  });

  await previousEdit;

  try {
    return await fetch(`${config.imageGenerationApiUrl.replace(/\/$/, "")}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.imageGenerationApiKey}`,
      },
      body: formData,
    });
  } finally {
    releaseEdit();
  }
}

export async function generateSticker(record: StickerRecord, options: GenerateOptions = {}): Promise<StickerResult> {
  const count = options.count ?? 5;
  const generationStartedAt = Date.now();
  const generatedDirectory = path.join(runtimeGeneratedRoot, slugify(record.theme), slugify(record.description));
  const trialDirectory = path.join(generatedDirectory, `trial-${Date.now()}`);

  await mkdir(trialDirectory, { recursive: true });

  logGenerationStep("generation_started", {
    recordId: record.id,
    count,
    theme: slugify(record.theme),
    hasApiKey: Boolean(config.imageGenerationApiKey),
    refinement: Boolean(options.refinementRequirement),
  });

  const candidateUrls: Record<string, string> = {};
  let completedCount = 0;

  const settled: Array<{ index: number; candidatePath: string }> = [];
  const failures: unknown[] = [];
  let nextCandidateIndex = 0;
  const maxProviderAttempts = 3;

  async function generateCandidate(i: number): Promise<void> {
    const index = i + 1;
    const candidateStartedAt = Date.now();
    logGenerationStep("candidate_started", {
      recordId: record.id,
      candidate: `${index}/${count}`,
    });
    const fileName = config.imageGenerationApiKey
      ? `candidate-${String(index).padStart(2, "0")}.png`
      : record.format === "gif"
        ? `candidate-${String(index).padStart(2, "0")}.gif`
        : `candidate-${String(index).padStart(2, "0")}.svg`;
    const absolutePath = path.join(trialDirectory, fileName);

    if (config.imageGenerationApiKey) {
      for (let attempt = 1; attempt <= maxProviderAttempts; attempt += 1) {
        const attemptStartedAt = Date.now();
        try {
          await generateWithImageProvider(record, absolutePath, { ...options, count }, index);
          break;
        } catch (error) {
          const attemptElapsedMs = Date.now() - attemptStartedAt;
          if (
            attempt === maxProviderAttempts
            || attemptElapsedMs >= maxRetryableProviderAttemptMs
            || !isRetryableImageProviderError(error)
          ) {
            throw error;
          }

          logGenerationError("candidate_retrying", error, {
            recordId: record.id,
            candidate: `${index}/${count}`,
            attempt,
          });
        }
      }
    } else if (record.format === "gif") {
      await writeFile(absolutePath, `GIF placeholder candidate ${index}: image generation integration pending.\n`, "utf8");
    } else {
      await writeFile(absolutePath, buildPlaceholderSvg(record), "utf8");
    }

    logGenerationStep("candidate_file_written", {
      recordId: record.id,
      candidate: `${index}/${count}`,
      fileName,
      elapsedMs: Date.now() - candidateStartedAt,
    });

    const candidatePath = path.join(".runtime/generated", path.relative(runtimeGeneratedRoot, absolutePath)).replace(/\\/g, "/");
    logGenerationStep("candidate_blob_upload_started", {
      recordId: record.id,
      candidate: `${index}/${count}`,
    });
    const blobPathname = await uploadRuntimeCandidateBlob(record.id, candidatePath, absolutePath);
    logGenerationStep("candidate_blob_upload_completed", {
      recordId: record.id,
      candidate: `${index}/${count}`,
      uploaded: Boolean(blobPathname),
    });
    if (blobPathname) {
      candidateUrls[candidatePath] = blobPathname;
    }

    completedCount += 1;
    options.onProgress?.(completedCount, count, candidatePath);
    logGenerationStep("candidate_progress", {
      recordId: record.id,
      candidate: `${completedCount}/${count}`,
      candidatePath,
    });

    settled.push({ index, candidatePath });
  }

  async function generateNextCandidate(): Promise<void> {
    while (nextCandidateIndex < count) {
      const candidateIndex = nextCandidateIndex;
      nextCandidateIndex += 1;

      try {
        await generateCandidate(candidateIndex);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  const workerCount = Math.min(count, config.imageGenerationConcurrency);
  await Promise.all(Array.from({ length: workerCount }, generateNextCandidate));

  if (settled.length === 0) {
    const error = failures[0];
    logGenerationError("generation_failed", error, {
      recordId: record.id,
      elapsedMs: Date.now() - generationStartedAt,
    });
    throw error;
  }

  settled.sort((a, b) => a.index - b.index);
  const candidates = settled.map((r) => r.candidatePath);

  logGenerationStep("generation_completed", {
    recordId: record.id,
    count: candidates.length,
    elapsedMs: Date.now() - generationStartedAt,
  });

  return {
    provider: config.imageGenerationApiKey ? "gpt-image-2" : "placeholder",
    format: record.format,
    candidates,
    candidateUrls,
    localPath: candidates[0],
    selectedPath: candidates[0],
    refinementRequirement: options.refinementRequirement,
  };
}
