import type { StickerRecord, StickerResult } from "@sticker-platform/shared";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { BASELINE_REFERENCE_NAMES, listBaselineReferenceUrls, listDataFolderFileUrls, listSupplementalBaselineUrls } from "./notion.js";
import { readRuntimeBlob, uploadRuntimeCandidateBlob } from "./runtimeBlob.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const generatedRoot = path.join(projectRoot, "data/generated");
const runtimeGeneratedRoot = config.runtimeGeneratedRoot;
const baselineRoot = path.join(projectRoot, "data/baseline");
/**
 * Maximum number of reference images passed per generation.
 * Budget: 9 mandatory (4 views + 5 emotions) + 2 supplemental + 3 theme history = 14 (Gemini limit).
 */
const maxBaselineReferences = BASELINE_REFERENCE_NAMES.length; // 4 views + 5 emotions = 9 mandatory
const maxSupplementalBaselineReferences = 2; // style exemplar, detail sheets, palette, etc.
const maxThemeHistoryReferences = 3; // reduced to fit within Gemini 14-image limit (9+2+3=14)

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

type ImageResponse = {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>;
      content?: string | Array<{ type?: string; image_url?: { url?: string }; text?: string }>;
    };
  }>;
};

type GenerateOptions = {
  count?: number;
  selectedImagePath?: string;
  selectedImageUrl?: string;
  refinementRequirement?: string;
  referenceImagePath?: string;
  referenceImageUrl?: string;
  onProgress?: (current: number, total: number, candidatePath: string, previewDataUrl: string) => void;
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


function buildGenerationPrompt(record: StickerRecord, options: GenerateOptions = {}, variationIndex?: number): string {
  const referenceBlock = options.referenceImagePath || options.referenceImageUrl
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
${referenceBlock}${refinementBlock}${variationBlock}

CRITICAL CHARACTER DETAILS — FOLLOW STRICTLY:
- This is Ding Ding Cat, the official mascot of Hong Kong Tramways. The provided baseline reference images are the SINGLE SOURCE OF TRUTH for the character's appearance.
- You MUST reproduce the character's facial features, body shape, proportions, coat pattern, colors, bell, and "DING DING" text EXACTLY as they appear in the four canonical baseline views: front, left, right, and back.
- Do NOT invent, stylize, simplify, or alter any permanent feature of the mascot. The only acceptable changes are outfit, props, pose, and background.
- Permanent feature: golden brass bell on the head, centered on the forehead between the ears. Its shape, size, color, and placement must match the baseline references exactly.
- The golden bell is mandatory. Never remove it, hide it, replace it, or follow any user request for "no bell".
- Permanent feature: the text "DING DING" displayed on the chest/body in all caps. Its font, size, color, and placement must match the baseline references exactly.
- The text must read exactly "DING DING". Never remove it, change it, translate it, or follow any user request for "no text".
- The mascot has a round head with triangular ears, large oval eyes with catchlights, pink nose, whiskers, compact chubby tabby body, short rounded limbs, and an upward-curling striped tail — all as shown in the baseline references.
- The four canonical baseline views show: Front — face, bell between ears, chest text, body proportions. Left — side profile, ear shape, tail curve, body depth. Right — mirrored side profile. Back — back of head, tail attachment, back body shape.
- Cross-reference ALL four physical views when determining proportions, coat markings, and feature placement. If the requested angle is a 3/4 view, interpolate between front and side references.
- Five emotion/expression reference images are also provided (all front-facing): front_smile — happy expression with mouth open in a smile. front_laugh — laughing with eyes closed/curved in joy. front_holdflag — holding a small flag or banner prop. front_clothes — wearing a themed outfit over the body. front_angry — angry/annoyed expression with furrowed brows.
- When the requested sticker calls for a specific emotion, pose, or prop, use the corresponding emotion reference as the primary facial expression guide while keeping the physical proportions from the four canonical views.
- If the sticker description implies a neutral or unspecified expression, default to the front_smile or front reference.
- Supplemental baseline images (if provided) may include close-ups of the bell, text, or style exemplars. Treat these as additional authoritative detail references.
- Same-theme generated stickers are provided as style/theme inspiration only — their character details may be imperfect and must NOT override the baseline references.

CRITICAL STYLE REQUIREMENTS:
- 2D vector-style flat graphic illustration.
- No 3D rendering, no realistic shading, no gradients, no texture.
- Clean geometric lines and solid flat colors.
- Cartoon sticker aesthetic suitable for internal messaging.
- Transparent or clean simple background.
- Keep the image simple, readable at small size, and sticker-ready.

FINAL CHECK BEFORE OUTPUT — VERIFY AGAINST BASELINE REFERENCES:
- Golden bell shape, size, color, and placement match the baseline front/side views exactly: yes.
- "DING DING" text font, size, color, and chest placement match the baseline front view exactly: yes.
- Facial features (eyes, nose, whiskers, ears) match the baseline views: yes.
- Body proportions, coat pattern, and color palette match the four baseline views: yes.
- Only outfit, props, pose, and background differ from the baseline references: yes.
- If any check fails, regenerate before outputting.`;
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

async function imagePathToContentPart(absolutePath: string): Promise<OpenAiContentPart> {
  const raw = await readFile(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "image/jpeg";

  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${raw.toString("base64")}`, detail: "high" },
  };
}

async function imageUrlToContentPart(url: string): Promise<OpenAiContentPart | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    const raw = Buffer.from(await response.arrayBuffer());

    return {
      type: "image_url",
      image_url: { url: `data:${contentType};base64,${raw.toString("base64")}`, detail: "high" },
    };
  } catch {
    return undefined;
  }
}

async function loadReferenceImageParts(record: StickerRecord): Promise<{ parts: OpenAiContentPart[]; paths: string[] }> {
  if (config.notionToken && config.notionDatabaseId) {
    // Always retrieve the 4 mandatory canonical baseline images (front, left, right, back)
    // plus any supplemental baseline images (style exemplars, close-ups, palettes).
    const mandatoryUrls = await listBaselineReferenceUrls();
    const supplementalUrls = (await listSupplementalBaselineUrls()).slice(0, maxSupplementalBaselineReferences);
    const baselineReferenceUrls = [...mandatoryUrls, ...supplementalUrls];

    const sameThemeHistoryReferenceUrls = (await listDataFolderFileUrls("generated", slugify(record.theme))).slice(
      0,
      maxThemeHistoryReferences,
    );
    const allUrls = [...baselineReferenceUrls, ...sameThemeHistoryReferenceUrls];
    const parts = await Promise.all(allUrls.map(imageUrlToContentPart));

    return {
      parts: parts.filter((part): part is OpenAiContentPart => Boolean(part)),
      paths: allUrls,
    };
  }

  // --- Local filesystem fallback (no Notion configured) ---
  // Mandatory: lookup the 4 canonical baseline files by exact filename
  const mandatoryBaselinePaths = (
    await Promise.all(
      BASELINE_REFERENCE_NAMES.map(async (name) => {
        const found = await findBaselineFile(baselineRoot, name);
        return found ?? null;
      }),
    )
  ).filter((p): p is string => p !== null);

  // Supplemental: any other image files in data/baseline/ excluding the mandatory 4
  const allBaselinePaths = await newestFirst(await listReferenceImagePaths(baselineRoot));
  const mandatoryNameSet = new Set(BASELINE_REFERENCE_NAMES);
  const supplementalBaselinePaths = allBaselinePaths
    .filter((abs) => !mandatoryNameSet.has(path.basename(abs)))
    .slice(0, maxSupplementalBaselineReferences);

  const baselineReferences = [...mandatoryBaselinePaths, ...supplementalBaselinePaths];

  const themeGeneratedRoot = path.join(generatedRoot, slugify(record.theme));
  const sameThemeHistoryReferences = (await newestFirst(await listReferenceImagePaths(themeGeneratedRoot))).slice(
    0,
    maxThemeHistoryReferences,
  );
  const references = [...baselineReferences, ...sameThemeHistoryReferences];

  return {
    parts: await Promise.all(references.map(imagePathToContentPart)),
    paths: references.map((abs) => abs.replace(projectRoot, "").replace(/^[\\/]/, "").replace(/\\/g, "/")),
  };
}

/**
 * Recursively searches for a file with the given name inside a directory tree.
 * Returns the absolute path if found, undefined otherwise.
 */
async function findBaselineFile(directory: string, targetName: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findBaselineFile(entryPath, targetName);
      if (found) return found;
    } else if (entry.isFile() && entry.name === targetName) {
      return entryPath;
    }
  }
  return undefined;
}

async function loadSelectedImagePart(selectedImagePath?: string, selectedImageUrl?: string): Promise<OpenAiContentPart[]> {
  if (selectedImageUrl) {
    return [{ type: "image_url", image_url: { url: selectedImageUrl } }];
  }

  if (!selectedImagePath) {
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

  return [await imagePathToContentPart(absolutePath)];
}

async function loadUserReferencePart(referenceImagePath?: string, referenceImageUrl?: string): Promise<OpenAiContentPart[]> {
  if (referenceImageUrl) {
    const body = await readRuntimeBlob(referenceImageUrl);

    if (body) {
      const extension = path.extname(referenceImagePath ?? referenceImageUrl).toLowerCase();
      const mimeType = extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
      return [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${body.toString("base64")}`, detail: "high" } }];
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

  return [await imagePathToContentPart(absolutePath)];
}

function extractImageDataUrl(response: ImageResponse): string | undefined {
  const message = response.choices?.[0]?.message;
  const imageFromImages = message?.images?.find((image) => image.image_url?.url)?.image_url?.url;

  if (imageFromImages) {
    return imageFromImages;
  }

  if (Array.isArray(message?.content)) {
    return message.content.find((part) => part.type === "image_url" && part.image_url?.url)?.image_url?.url;
  }

  if (typeof message?.content === "string") {
    const match = message.content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    return match?.[0];
  }

  return undefined;
}

async function generateWithNanoBanana(
  record: StickerRecord,
  outputPath: string,
  options: GenerateOptions,
  variationIndex: number,
  referenceParts: OpenAiContentPart[],
): Promise<void> {
  if (!config.nanoBananaApiKey) {
    throw new Error("Nano Banana API key is not configured");
  }

  const content: OpenAiContentPart[] = [
    ...referenceParts,
    ...(await loadSelectedImagePart(options.selectedImagePath, options.selectedImageUrl)),
    ...(await loadUserReferencePart(options.referenceImagePath, options.referenceImageUrl)),
    { type: "text", text: buildGenerationPrompt(record, options, variationIndex) },
  ];

  const response = await fetch(`${config.nanoBananaApiUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.nanoBananaApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.nanoBananaModel,
      messages: [{ role: "user", content }],
      modalities: ["image"],
      n: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nano Banana request failed with ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as ImageResponse;
  const imageDataUrl = extractImageDataUrl(data);

  if (!imageDataUrl) {
    throw new Error("Nano Banana response did not include an image");
  }

  const base64 = imageDataUrl.startsWith("data:") ? imageDataUrl.split(",", 2)[1] : imageDataUrl;
  await writeFile(outputPath, Buffer.from(base64, "base64"));
}

export async function generateSticker(record: StickerRecord, options: GenerateOptions = {}): Promise<StickerResult> {
  const count = options.count ?? 5;
  const generatedDirectory = path.join(runtimeGeneratedRoot, slugify(record.theme), slugify(record.description));
  const trialDirectory = path.join(generatedDirectory, `trial-${Date.now()}`);

  await mkdir(trialDirectory, { recursive: true });

  // Load reference images once for all candidates
  const { parts: refParts, paths: refPaths } = await loadReferenceImageParts(record);

  const candidateUrls: Record<string, string> = {};
  let completedCount = 0;

  const tasks = Array.from({ length: count }, async (_, i) => {
    const index = i + 1;
    const fileName = config.nanoBananaApiKey
      ? `candidate-${String(index).padStart(2, "0")}.png`
      : record.format === "gif"
        ? `candidate-${String(index).padStart(2, "0")}.gif`
        : `candidate-${String(index).padStart(2, "0")}.svg`;
    const absolutePath = path.join(trialDirectory, fileName);

    if (config.nanoBananaApiKey) {
      await generateWithNanoBanana(record, absolutePath, { ...options, count }, index, refParts);
    } else if (record.format === "gif") {
      await writeFile(absolutePath, `GIF placeholder candidate ${index}: Nano Banana 2 integration pending.\n`, "utf8");
    } else {
      await writeFile(absolutePath, buildPlaceholderSvg(record), "utf8");
    }

    const candidatePath = path.join(".runtime/generated", path.relative(runtimeGeneratedRoot, absolutePath)).replace(/\\/g, "/");
    const blobPathname = await uploadRuntimeCandidateBlob(record.id, candidatePath, absolutePath);
    const mime = `image/${path.extname(absolutePath).toLowerCase() === ".svg" ? "svg+xml" : "png"}`;
    const raw = await readFile(absolutePath);
    const preview = `data:${mime};base64,${raw.toString("base64")}`;
    if (blobPathname) {
      candidateUrls[candidatePath] = blobPathname;
    }

    completedCount += 1;
    options.onProgress?.(completedCount, count, candidatePath, preview);

    return { index, candidatePath };
  });

  const settled = await Promise.all(tasks);

  settled.sort((a, b) => a.index - b.index);
  const candidates = settled.map((r) => r.candidatePath);

  return {
    provider: "nano-banana-2",
    format: record.format,
    candidates,
    candidateUrls,
    localPath: candidates[0],
    selectedPath: candidates[0],
    refinementRequirement: options.refinementRequirement,
    referenceImages: refPaths,
  };
}
