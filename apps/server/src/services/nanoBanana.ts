import type { StickerRecord, StickerResult } from "@sticker-platform/shared";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { listDataFolderFileUrls } from "./notion.js";
import { uploadRuntimeCandidateBlob } from "./runtimeBlob.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const generatedRoot = path.join(projectRoot, "data/generated");
const runtimeGeneratedRoot = config.runtimeGeneratedRoot;
const baselineRoot = path.join(projectRoot, "data/baseline");
const maxBaselineReferences = 8;
const maxThemeHistoryReferences = 8;
const maxGenerationRetries = 1;

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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


function buildGenerationPrompt(record: StickerRecord, options: GenerateOptions = {}, variationIndex?: number): string {
  const referenceBlock = options.referenceImagePath
    ? `\nUSER-PROVIDED REFERENCE IMAGE:\n- The uploaded image contains visual elements the user wants included.\n- Incorporate key visual elements (objects, colors, composition ideas) from the uploaded image into the sticker design.\n- The Ding Ding Cat character must remain the primary subject.\n- Adapt the uploaded image's elements to fit the 2D vector flat-graphic sticker style described below.\n`
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

CRITICAL CHARACTER DETAILS:
- This is Ding Ding Cat, the official mascot of Hong Kong Tramways.
- The mascot has the text "DING DING" displayed on its head or body.
- The text must read exactly "DING DING". Do not change it to another word.
- Use the provided baseline images as the original mascot reference material.
- Use the provided same-theme generated stickers as style/history references.
- Copy the mascot's face, body, proportions, colors, and text faithfully from the reference images when provided.
- Only change the outfit, props, pose, and background to match the requested scene.

CRITICAL STYLE REQUIREMENTS:
- 2D vector-style flat graphic illustration.
- No 3D rendering, no realistic shading, no gradients, no texture.
- Clean geometric lines and solid flat colors.
- Cartoon sticker aesthetic suitable for internal messaging.
- Transparent or clean simple background.
- Keep the image simple, readable at small size, and sticker-ready.`;
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
    image_url: { url: `data:${mimeType};base64,${raw.toString("base64")}` },
  };
}

async function loadReferenceImageParts(record: StickerRecord): Promise<OpenAiContentPart[]> {
  if (config.notionToken && config.notionDatabaseId) {
    const baselineReferenceUrls = (await listDataFolderFileUrls("baseline")).slice(0, maxBaselineReferences);
    const sameThemeHistoryReferenceUrls = (await listDataFolderFileUrls("generated", slugify(record.theme))).slice(
      0,
      maxThemeHistoryReferences,
    );

    return [...baselineReferenceUrls, ...sameThemeHistoryReferenceUrls].map((url) => ({
      type: "image_url",
      image_url: { url },
    }));
  }

  const themeGeneratedRoot = path.join(generatedRoot, slugify(record.theme));
  const baselineReferences = (await newestFirst(await listReferenceImagePaths(baselineRoot))).slice(0, maxBaselineReferences);
  const sameThemeHistoryReferences = (await newestFirst(await listReferenceImagePaths(themeGeneratedRoot))).slice(
    0,
    maxThemeHistoryReferences,
  );
  const references = [...baselineReferences, ...sameThemeHistoryReferences];

  return Promise.all(references.map(imagePathToContentPart));
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

async function loadUserReferencePart(referenceImagePath?: string): Promise<OpenAiContentPart[]> {
  if (!referenceImagePath) {
    return [];
  }

  const absolutePath = path.resolve(projectRoot, referenceImagePath);
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

function buildVerificationPrompt(record: StickerRecord): string {
  return `You are a strict quality control reviewer. Examine this generated sticker image and verify it meets ALL requirements.

Respond with ONLY a valid JSON object (no markdown fences, no extra text):
{"pass":true/false,"issues":["specific issue found"],"score":0-100}

CRITICAL REQUIREMENTS TO VERIFY:
1. MAIN SUBJECT: A recognizable cat mascot character is the primary subject of the image.
2. "DING DING" TEXT: The text "DING DING" must be clearly visible on the cat character's head area. It must read exactly "DING DING".
3. FLAT 2D VECTOR STYLE: Clean geometric lines and solid flat colors only. Must NOT contain 3D rendering, realistic shading, gradients, or visible texture.
4. FESTIVAL THEME: The props, colors, and scene must clearly match the requested theme: ${describeTheme(record.theme)}.
5. STICKER-READABLE: The image must be simple enough to be readable at small messaging-app sticker size (clear shapes, not overly detailed).`;
}

type VerificationResult = { pass: boolean; issues: string[] };

async function verifyStickerCompliance(
  record: StickerRecord,
  imageDataUrl: string,
): Promise<VerificationResult> {
  if (!config.nanoBananaApiKey) {
    return { pass: true, issues: [] };
  }

  try {
    const content: OpenAiContentPart[] = [
      { type: "image_url", image_url: { url: imageDataUrl } },
      { type: "text", text: buildVerificationPrompt(record) },
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
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      return { pass: true, issues: [] };
    }

    const data = (await response.json()) as ImageResponse;
    const text = data.choices?.[0]?.message?.content;

    if (!text || typeof text !== "string") {
      return { pass: true, issues: [] };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { pass: true, issues: [] };
    }

    const result = JSON.parse(jsonMatch[0]) as { pass?: boolean; issues?: string[] };

    return {
      pass: result.pass !== false,
      issues: Array.isArray(result.issues) ? result.issues : [],
    };
  } catch {
    return { pass: true, issues: [] };
  }
}

const verificationLogDir = path.join(projectRoot, ".runtime/logs");
const verificationLogPath = path.join(verificationLogDir, "verification.jsonl");

async function logVerificationResult(entry: Record<string, unknown>): Promise<void> {
  await appendFile(verificationLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function generateWithNanoBanana(
  record: StickerRecord,
  outputPath: string,
  options: GenerateOptions,
  variationIndex: number,
): Promise<void> {
  if (!config.nanoBananaApiKey) {
    throw new Error("Nano Banana API key is not configured");
  }

  let currentOptions = options;
  let lastIssues: string[] = [];

  for (let attempt = 0; attempt <= maxGenerationRetries; attempt++) {
    const content: OpenAiContentPart[] = [
      ...(await loadReferenceImageParts(record)),
      ...(await loadSelectedImagePart(currentOptions.selectedImagePath, currentOptions.selectedImageUrl)),
      ...(await loadUserReferencePart(currentOptions.referenceImagePath)),
      { type: "text", text: buildGenerationPrompt(record, currentOptions, variationIndex) },
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

    const verification = await verifyStickerCompliance(record, imageDataUrl);

    await mkdir(verificationLogDir, { recursive: true });
    await logVerificationResult({
      timestamp: new Date().toISOString(),
      recordId: record.id,
      theme: record.theme,
      description: record.description,
      candidate: variationIndex,
      attempt: attempt + 1,
      pass: verification.pass,
      issues: verification.issues,
    });

    if (verification.pass) {
      await writeFile(outputPath, Buffer.from(base64, "base64"));
      return;
    }

    lastIssues = verification.issues;

    if (attempt < maxGenerationRetries) {
      console.log(
        `Candidate ${variationIndex} attempt ${attempt + 1} failed verification: ${lastIssues.slice(0, 3).join("; ")}. Retrying...`,
      );

      currentOptions = {
        ...currentOptions,
        refinementRequirement: [
          currentOptions.refinementRequirement,
          `Fix these issues from the previous attempt: ${lastIssues.join(". ")}`,
        ]
          .filter(Boolean)
          .join(" "),
      };
      continue;
    }

    console.log(
      `Candidate ${variationIndex} accepted after ${maxGenerationRetries} retries. Remaining issues: ${lastIssues.slice(0, 3).join("; ")}`,
    );

    await writeFile(outputPath, Buffer.from(base64, "base64"));
    return;
  }
}

export async function generateSticker(record: StickerRecord, options: GenerateOptions = {}): Promise<StickerResult> {
  const count = options.count ?? 5;
  const generatedDirectory = path.join(runtimeGeneratedRoot, slugify(record.theme), slugify(record.description));
  const trialDirectory = path.join(generatedDirectory, `trial-${Date.now()}`);

  await mkdir(trialDirectory, { recursive: true });

  let completedCount = 0;
  const candidates: string[] = [];
  const candidateUrls: Record<string, string> = {};

  const tasks = Array.from({ length: count }, async (_, i) => {
    const index = i + 1;
    const fileName = config.nanoBananaApiKey
      ? `candidate-${String(index).padStart(2, "0")}.png`
      : record.format === "gif"
        ? `candidate-${String(index).padStart(2, "0")}.gif`
        : `candidate-${String(index).padStart(2, "0")}.svg`;
    const absolutePath = path.join(trialDirectory, fileName);

    if (config.nanoBananaApiKey) {
      await generateWithNanoBanana(record, absolutePath, { ...options, count }, index);
    } else if (record.format === "gif") {
      await writeFile(absolutePath, `GIF placeholder candidate ${index}: Nano Banana 2 integration pending.\n`, "utf8");
    } else {
      await writeFile(absolutePath, buildPlaceholderSvg(record), "utf8");
    }

    const candidatePath = path.join(".runtime/generated", path.relative(runtimeGeneratedRoot, absolutePath)).replace(/\\/g, "/");
    const mime = `image/${path.extname(absolutePath).toLowerCase() === ".svg" ? "svg+xml" : "png"}`;
    const raw = await readFile(absolutePath);
    const preview = `data:${mime};base64,${raw.toString("base64")}`;

    const blobPathname = await uploadRuntimeCandidateBlob(record.id, candidatePath, absolutePath);
    if (blobPathname) {
      candidateUrls[candidatePath] = blobPathname;
    }

    completedCount += 1;
    options.onProgress?.(completedCount, count, candidatePath, preview);

    return { index, candidatePath };
  });

  const settled = await Promise.all(tasks);

  settled.sort((a, b) => a.index - b.index);
  candidates.push(...settled.map((r) => r.candidatePath));

  return {
    provider: "nano-banana-2",
    format: record.format,
    candidates,
    candidateUrls,
    localPath: candidates[0],
    selectedPath: candidates[0],
    refinementRequirement: options.refinementRequirement,
  };
}
