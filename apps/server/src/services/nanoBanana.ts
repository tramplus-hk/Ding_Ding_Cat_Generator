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

// ── Gemini native types ──

type GeminiFileDataPart = { fileData: { mimeType: string; fileUri: string } };
type GeminiTextPart = { text: string };
type GeminiContentPart = GeminiTextPart | GeminiFileDataPart;

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<
        | { text?: string; inlineData?: { mimeType: string; data: string } }
        | { inlineData?: { mimeType: string; data: string }; text?: string }
      >;
    };
  }>;
};

// ── Gemini File API helpers ──

const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_GENERATE_BASE = "https://generativelanguage.googleapis.com/v1beta";

function mimeTypeFromFilePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

/**
 * Upload raw image bytes to Gemini File API.
 * Returns the file URI (e.g. "https://generativelanguage.googleapis.com/v1beta/files/abc-123")
 * that can be referenced via fileData in a generateContent request.
 */
async function uploadBufferToGemini(buffer: Buffer, mimeType: string, displayName: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${GEMINI_UPLOAD_BASE}?key=${config.geminiApiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(buffer.length),
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: buffer,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`Gemini file upload failed (${response.status}): ${text.slice(0, 300)}`);
      return undefined;
    }

    const data = (await response.json()) as { file?: { name?: string; uri?: string } };
    return data.file?.uri ?? data.file?.name;
  } catch (err) {
    console.error("Gemini file upload error:", err);
    return undefined;
  }
}

/**
 * Upload an image source (local file path or HTTP URL) to Gemini File API.
 */
async function uploadImageToGemini(source: string): Promise<string | undefined> {
  let buffer: Buffer;
  let mimeType: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) return undefined;
    mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    buffer = await readFile(source);
    mimeType = mimeTypeFromFilePath(source);
  }

  const displayName = path.basename(source.split("?")[0]);
  return uploadBufferToGemini(buffer, mimeType, displayName);
}

/**
 * Upload multiple image sources in parallel and return the file URIs.
 */
async function uploadImagesToGemini(sources: string[]): Promise<string[]> {
  const results = await Promise.all(sources.map((s) => uploadImageToGemini(s)));
  return results.filter((uri): uri is string => Boolean(uri));
}

/**
 * Call Gemini generateContent with file URIs (no base64).
 * Returns the raw Buffer of the generated image.
 */
async function geminiGenerateContent(
  primingText: string,
  fileUris: string[],
  prompt: string,
  model: string,
): Promise<Buffer> {
  const parts: GeminiContentPart[] = [
    { text: primingText },
    ...fileUris.map((uri) => ({
      fileData: { mimeType: "image/png", fileUri: uri } as GeminiFileDataPart["fileData"],
    })),
    { text: prompt },
  ];

  const response = await fetch(
    `${GEMINI_GENERATE_BASE}/${model}:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini generateContent failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as GeminiGenerateResponse;
  const parts_ = data.candidates?.[0]?.content?.parts;

  if (!parts_) {
    throw new Error("Gemini response did not include content parts");
  }

  // Find the inlineData part with the generated image
  for (const part of parts_) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }

  throw new Error("Gemini response did not include an image");
}

// ── GPT Image 2 helpers (multipart file upload, no base64) ──

type ReferenceBuffer = { buffer: Buffer; filename: string; mimeType: string };

/**
 * Load raw image bytes from the sources returned by loadReferenceImageParts().
 * Sources can be local file paths or HTTP URLs (Notion).
 */
async function loadReferenceBuffers(sources: string[]): Promise<ReferenceBuffer[]> {
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        if (source.startsWith("http://") || source.startsWith("https://")) {
          const response = await fetch(source);
          if (!response.ok) return null;
          const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
          const buffer = Buffer.from(await response.arrayBuffer());
          return { buffer, filename: path.basename(new URL(source).pathname) || "reference.png", mimeType };
        }
        const buffer = await readFile(source);
        const mimeType = mimeTypeFromFilePath(source);
        return { buffer, filename: path.basename(source), mimeType };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null) as ReferenceBuffer[];
}

/**
 * Generate a single sticker candidate using GPT Image 2 via the AI Gateway.
 * Reference images are sent as multipart form-data fields — no base64 encoding.
 *
 * Uses the /v1/images/generations endpoint (not chat completions).
 */
async function generateWithGptImage2(
  record: StickerRecord,
  outputPath: string,
  options: GenerateOptions,
  variationIndex: number,
  referenceBuffers: ReferenceBuffer[],
  extraImageBuffers: ReferenceBuffer[],
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  const primingText =
    `🔴 PRIMING INSTRUCTION — STUDY THESE REFERENCE IMAGES FIRST:\n` +
    `You are an expert sticker designer for Hong Kong Tramways. The attached reference ` +
    `images show DING DING CAT — the official mascot of TramPlus. This is a SPECIFIC ` +
    `character with a fixed, established design. STUDY EVERY ATTACHED IMAGE CAREFULLY.\n\n` +
    `The reference images show:\n` +
    `  Images 1–4: Four canonical physical views (front, left, right, back).\n` +
    `  Images 5–9: Five emotion/expression variants.\n` +
    `  Images 10+: Supplemental style references and previously generated stickers.\n\n` +
    `IMPORTANT: Pay special attention to Image 1 (front view) — look at the golden bell ` +
    `on the forehead, the "DING DING" text on the chest, and the exact coat pattern. ` +
    `YOU MUST REPRODUCE THE EXACT CHARACTER FROM THESE IMAGES. Do NOT draw a different cat.\n`;

  const prompt = buildGenerationPrompt(record, options, variationIndex);
  const fullPrompt = `${primingText}\n\n${prompt}`;

  // Build multipart form data with all reference images
  const formData = new FormData();
  formData.append("model", config.gptImageModel);
  formData.append("prompt", fullPrompt);
  formData.append("n", "1");
  formData.append("size", "1024x1024");
  formData.append("response_format", "b64_json");

  const allBuffers = [...referenceBuffers, ...extraImageBuffers];

  if (allBuffers.length > 0) {
    for (const ref of allBuffers) {
      const blob = new Blob([ref.buffer], { type: ref.mimeType });
      formData.append("image", blob, ref.filename);
    }
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GPT Image 2 request failed with ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;

  if (!b64) {
    throw new Error("GPT Image 2 response did not include b64_json image data");
  }

  await writeFile(outputPath, Buffer.from(b64, "base64"));
}

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
    halloween: "Halloween: jack-o-lantern, witch hat, bats, spooky elements",
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 WHO IS DING DING CAT — READ THIS FIRST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Ding Ding Cat is the official mascot of Hong Kong Tramways (TramPlus). This is a SPECIFIC established character design, NOT a generic cat. You have been shown reference images of this character. You MUST reproduce the EXACT character from those reference images — do NOT draw a different cat.

The reference images provided above are organized as follows:
  Reference Images 1–4: Four canonical physical views (front, left, right, back)
  Reference Images 5–9: Five emotion/expression variants (front_smile, front_laugh, front_holdflag, front_clothes, front_angry)
  Reference Images 10+: Supplemental style references and theme exemplars

These reference images are your ONLY authoritative source for the character's appearance. COPY the character from these images. Do not rely on your training data about cats or cartoon cats — Ding Ding Cat is a unique character and only the reference images show the correct design.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 CHARACTER DESIGN — MUST MATCH EXACTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Head & Face (match Reference Images 1, 5–9):
  - Round head shape with two triangular ears on top. Ears have inner pink/light coloring (match reference exactly).
  - Large oval eyes with white catchlights/highlights. Eye shape, size, spacing, iris color, and pupil style must match the references precisely.
  - Small pink triangular nose centered below the eyes.
  - Whiskers: 2–3 thin lines on each cheek, matching the reference angle and length.
  - Mouth: small curved line below the nose. Expression (smile, laugh, angry) must match the requested emotion.
  - Face shape and feature placement must be pixel-identical in spirit to Image 1 (front.png reference).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔔 GOLDEN BELL — PERMANENT, IMMUTABLE, NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  This is the #1 most critical feature of Ding Ding Cat. The bell is the character's BRAND IDENTITY MARKER. Without the CORRECT bell, it is NOT Ding Ding Cat. This is an industrial production requirement — zero tolerance for bell variation.

  THE GOLDEN BELL MUST BE AN EXACT COPY OF THE BELL SHOWN IN REFERENCE IMAGE 1 (front.png). Not "inspired by." Not "similar to." EXACT. COPY.

  SPECIFICATIONS — Every detail is mandatory:
  ⬤ SHAPE: A PERFECT CIRCLE (not oval, not squashed, not elongated). Round like a coin. The ratio of width to height must be 1:1.
  ⬤ SIZE: Approximately 1/6 to 1/5 of the width of the head. Not tiny. Not oversized. Reference Image 1 shows the exact proportion — COPY IT.
  ⬤ PLACEMENT: Dead center on the forehead, horizontally aligned between the eyes, vertically positioned above the eye line and below the ear tips. The distance from the top of the eyes to the bottom of the bell should match Reference Image 1 exactly.
  ⬤ COLOR: Warm metallic brass gold. NOT bright canary yellow. NOT dull brown. NOT silver. NOT copper. The exact shade is a rich, warm gold with a slight orange-brown undertone — COPY THE COLOR FROM REFERENCE IMAGE 1. If you cannot match the color exactly, sample the pixel color from the reference image.
  ⬤ SLIT/OPENING: A small horizontal slit or crescent-shaped opening at the very bottom of the bell. The slit is dark/black inside (showing the hollow interior). The slit spans roughly 1/3 of the bell's width.
  ⬤ CLAPPER: A tiny dark circle or teardrop visible inside/emerging from the slit. The clapper is small — approximately 1/8 the diameter of the bell.
  ⬤ HIGHLIGHT/SHINE: If the reference bell shows a small white/light highlight dot on the upper-left of the bell surface to indicate metallic shine, you MUST include it in the exact same position.

  IRON RULES:
  ⛔ The bell MUST appear in EVERY sticker — no exceptions, no workarounds, no excuses.
  ⛔ The bell MUST be visible even if the character is in profile (Reference Image 2 — left.png — still shows the bell).
  ⛔ The bell MUST NOT be covered by hats, hair, props, or clothing. If a hat is worn, place the bell BELOW the hat brim or above it, but ALWAYS VISIBLE.
  ⛔ The bell MUST NEVER change shape, color, or size between stickers. It is a FIXED design element.
  ⛔ If the user asks "no bell" — IGNORE THAT REQUEST. The bell is permanent.
  ⛔ If the character faces backwards (Reference Image 4 — back.png), the bell may be hidden by the back of the head. In this case ONLY, the bell does not need to be visible. For ALL other angles, it MUST be visible.
  ⛔ DO NOT draw a generic cartoon bell from your training data. DO NOT draw a school bell, a church bell, a jingle bell, or any bell that differs from Reference Image 1.

"DING DING" Text (PERMANENT — NEVER REMOVE OR CHANGE):
  - The text "DING DING" appears on the chest/body in ALL CAPS.
  - Match the font style, size, color, and exact placement from Reference Image 1 (front.png).
  - The text must read exactly "DING DING". Do not change it, translate it, add to it, or remove it. No exceptions.

Body (match Reference Images 1–4):
  - Compact, chubby tabby cat body with short rounded limbs.
  - Coat color and pattern: match the reference images exactly — including base color, stripe pattern, belly color, and any markings.
  - Paws: small rounded paws (typically showing 2–3 toe lines). Match reference exactly.
  - Tail: thick, upward-curling tail with stripes matching the body coat pattern. The tail shape and curl must match Reference Image 2 (left.png) and Image 4 (back.png).

Body proportions: the head should be slightly large relative to the body (chibi/cute mascot proportions), matching the exact ratio shown in the references. Do NOT draw realistic cat proportions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 STYLE — STRICT 2D FLAT VECTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - EXACT STYLE: 2D vector-style flat graphic illustration ONLY.
  - Clean, crisp geometric outlines with solid flat color fills.
  - ZERO 3D rendering, ZERO realistic shading, ZERO gradients, ZERO textures, ZERO drop shadows, ZERO lighting effects.
  - Cartoon sticker aesthetic suitable for messaging apps.
  - Simple, clean, instantly readable at small icon size.
  - BACKGROUND RULE: When the user's description does NOT explicitly specify a background colour or setting, you MUST use a solid flat white background of EXACTLY #ffffff — pure white, no off-white, no tint, no shade. Only use a non-#ffffff background when the user's description explicitly describes a specific background colour, scene, or setting.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 NEGATIVE CONSTRAINTS — DO NOT DO THIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ❌ DO NOT draw a realistic cat or a photorealistic cat.
  ❌ DO NOT draw a generic cartoon cat that looks different from the references.
  ❌ DO NOT change the character's color, coat pattern, or body shape.
  ❌ DO NOT use 3D rendering, gradients, realistic lighting, or textures.
  ❌ DO NOT remove, hide, or alter the golden bell on the forehead.
  ❌ DO NOT draw a random bell — no different shape, no different color, no different size. The bell must be pixel-identical to Reference Image 1.
  ❌ DO NOT draw a yellow circle and call it a bell. The bell has a slit, a clapper, and a metallic gold color — not flat yellow.
  ❌ DO NOT draw the bell as an oval, a diamond, a triangle, or any non-circular shape. PERFECT CIRCLE ONLY.
  ❌ DO NOT place the bell anywhere other than the exact center of the forehead as shown in Reference Image 1. Not on the chest, not on the cheek, not on the ear.
  ❌ DO NOT remove, change, or obscure the "DING DING" text.
  ❌ DO NOT add clothing that covers the "DING DING" text (the text must remain visible).
  ❌ DO NOT add clothing, hair, or accessories that cover or obscure the golden bell.
  ❌ DO NOT change the face style — the eye shape, nose, whiskers, and proportions are fixed.
  ❌ DO NOT draw a different animal (dog, bunny, bear) — this is specifically a CAT mascot.
  ❌ DO NOT copy any trademarked characters (Hello Kitty, Pokemon, Pusheen, etc.).
  ❌ DO NOT make the character look like a human or humanoid.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 EMOTION & POSE GUIDANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - The five emotion reference images show: smile (open happy mouth), laugh (eyes curved in joy), holdflag (holding a prop), clothes (wearing outfit), angry (furrowed brows).
  - For this sticker, use the expression that best matches the user's description. Default to friendly/smiling if unspecified.
  - Pose and props may vary per the user's request, but the character's body shape, face, bell, and text must remain IDENTICAL to the references.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 FINAL VERIFICATION — CHECK BEFORE OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Before finalizing the image, verify EVERY item below. If ANY check fails, FIX IT before outputting:

  ☑🔔 GOLDEN BELL AUDIT (MOST IMPORTANT — CHECK THIS FIRST):
     → Open Reference Image 1 (front.png) side by side with your output.
     → Is the bell a PERFECT CIRCLE? (Not oval, not squashed — width equals height exactly.)
     → Is the bell the SAME SIZE relative to the head as in Reference Image 1? (Approximately 1/5 of head width.)
     → Is the bell the EXACT SAME COLOR? (Warm metallic gold with orange-brown undertone. NOT bright yellow. NOT silver.)
     → Does the bell have a dark HORIZONTAL SLIT at the bottom with a tiny clapper inside?
     → Is the bell placed at the EXACT CENTER of the forehead, between and above the eyes, as in Reference Image 1?
     → If ANY of the above is NO → YOUR IMAGE IS REJECTED. Redraw the bell to match Reference Image 1 EXACTLY.

  ☑ "DING DING" text IS present on chest, matching Reference Image 1 in font/size/color/placement.
  ☑ Face IS Ding Ding Cat's face from the references — same eyes, nose, whiskers, ear shape.
  ☑ Body IS the chubby tabby cat body from the references — same proportions, coat, tail.
  ☑ Style IS 2D flat vector — NO 3D, NO gradients, NO textures, NO realistic shading.
  ☑ The character IS recognizably the SAME mascot shown in the reference images.
  ☑ Only outfit, props, pose, and background differ from the baseline references.

  If you are unsure about any detail, look at the reference images again. The reference images are the truth. Output NOTHING that contradicts them.`;
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

async function loadReferenceImageParts(record: StickerRecord): Promise<{ parts: OpenAiContentPart[]; sources: string[]; paths: string[] }> {
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
      sources: allUrls, // Notion file URLs — Gemini upload will fetch & re-upload them
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
    sources: references, // absolute paths — Gemini upload reads files from disk
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

async function loadSelectedImagePart(selectedImagePath?: string, selectedImageUrl?: string): Promise<{ parts: OpenAiContentPart[]; sources: string[] }> {
  if (selectedImageUrl) {
    const body = await readRuntimeBlob(selectedImageUrl);

    if (body) {
      const extension = path.extname(selectedImagePath ?? selectedImageUrl).toLowerCase();
      const mimeType = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "image/jpeg";

      return {
        parts: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${body.toString("base64")}`, detail: "high" } }],
        sources: [selectedImageUrl],
      };
    }
  }

  if (!selectedImagePath) {
    return { parts: [], sources: [] };
  }

  const absolutePath = selectedImagePath.startsWith(".runtime/generated/")
    ? path.resolve(runtimeGeneratedRoot, path.relative(".runtime/generated", selectedImagePath))
    : path.resolve(projectRoot, selectedImagePath);
  const isRuntimeGeneratedPath =
    absolutePath === runtimeGeneratedRoot || absolutePath.startsWith(`${runtimeGeneratedRoot}${path.sep}`);

  if (!isRuntimeGeneratedPath) {
    throw new Error("Selected image must be inside runtime generated storage");
  }

  return {
    parts: [await imagePathToContentPart(absolutePath)],
    sources: [absolutePath],
  };
}

async function loadUserReferencePart(referenceImagePath?: string, referenceImageUrl?: string): Promise<{ parts: OpenAiContentPart[]; sources: string[] }> {
  if (referenceImageUrl) {
    const body = await readRuntimeBlob(referenceImageUrl);

    if (body) {
      const extension = path.extname(referenceImagePath ?? referenceImageUrl).toLowerCase();
      const mimeType = extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
      return {
        parts: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${body.toString("base64")}`, detail: "high" } }],
        sources: [referenceImageUrl],
      };
    }
  }

  if (!referenceImagePath) {
    return { parts: [], sources: [] };
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

  return {
    parts: [await imagePathToContentPart(absolutePath)],
    sources: [absolutePath],
  };
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
  allGeminiFileUris: string[] = [],
  gptImageRefBuffers?: ReferenceBuffer[],
  gptImageExtraBuffers?: ReferenceBuffer[],
): Promise<void> {
  const prompt = buildGenerationPrompt(record, options, variationIndex);

  // ── GPT Image 2 path (highest priority — multipart files, no base64) ──
  if (config.gptImageModel && gptImageRefBuffers && gptImageRefBuffers.length > 0 && config.nanoBananaApiKey) {
    await generateWithGptImage2(
      record,
      outputPath,
      options,
      variationIndex,
      gptImageRefBuffers,
      gptImageExtraBuffers ?? [],
      config.nanoBananaApiUrl,
      config.nanoBananaApiKey,
    );
    return;
  }

  const primingText =
    `🔴 PRIMING INSTRUCTION — READ BEFORE VIEWING IMAGES:\n` +
    `You are an expert sticker designer for Hong Kong Tramways. You are about to see reference ` +
    `images of DING DING CAT — the official mascot of TramPlus. This is a SPECIFIC character ` +
    `with a fixed, established design. STUDY EVERY IMAGE WITH EXTREME CARE.\n\n` +
    `The reference images show:\n` +
    `  Images 1–4: Four canonical physical views (front, left, right, back) — these define the ` +
    `character's EXACT proportions, coat pattern, facial features, golden bell, and "DING DING" text.\n` +
    `  Images 5–9: Five emotion/expression variants (smile, laugh, holdflag, clothes, angry) — ` +
    `these show the character's face and body in different expressions/outfits.\n` +
    `  Images 10+: Supplemental style references and previously generated stickers.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔔 CRITICAL: THE GOLDEN BELL — STUDY THIS FIRST\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Before you draw ANYTHING, locate Reference Image 1 (front.png). STARE at the gold bell on ` +
    `the forehead. Burn it into your memory. This is the SINGLE MOST CRITICAL feature of Ding Ding Cat.\n\n` +
    `The bell you see in Reference Image 1 is THE ONLY CORRECT BELL. Every sticker you generate ` +
    `MUST have this EXACT SAME bell. Not a similar bell. Not a yellow circle. Not a brass pendant. ` +
    `Not a bell you remember from other cartoon cats. THE EXACT BELL FROM REFERENCE IMAGE 1.\n\n` +
    `Check Reference Images 5–9 as well — the SAME bell appears in every one of them. If the bell ` +
    `looks different in your output than it does in EVERY reference image, YOU HAVE FAILED.\n\n` +
    `YOU MUST REPRODUCE THE EXACT CHARACTER FROM THESE IMAGES. Do NOT draw a different cat. ` +
    `Do NOT invent a different face, different colors, or different proportions. The reference ` +
    `images are your ONLY truth for what Ding Ding Cat looks like. After studying all images ` +
    `carefully, follow the generation instructions that follow.\n`;

  // ── Gemini File API path (preferred — no base64) ──
  if (config.geminiApiKey && allGeminiFileUris.length > 0) {
    const model = config.geminiModel;
    const imageBuffer = await geminiGenerateContent(primingText, allGeminiFileUris, prompt, model);
    await writeFile(outputPath, imageBuffer);
    return;
  }

  // ── AI Gateway fallback (base64 inline) ──
  if (!config.nanoBananaApiKey) {
    throw new Error("Neither GEMINI_API_KEY nor NANO_BANANA_API_KEY is configured");
  }

  const primingInstruction: OpenAiContentPart = {
    type: "text",
    text: primingText,
  };

  const selected = await loadSelectedImagePart(options.selectedImagePath, options.selectedImageUrl);
  const userRef = await loadUserReferencePart(options.referenceImagePath, options.referenceImageUrl);

  const content: OpenAiContentPart[] = [
    primingInstruction,
    ...referenceParts,
    ...selected.parts,
    ...userRef.parts,
    { type: "text", text: prompt },
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
  const { parts: refParts, sources: refSources, paths: refPaths } = await loadReferenceImageParts(record);

  // ── GPT Image 2: pre-load reference buffers + selected/user-ref for multipart upload ──
  let gptImageRefBuffers: ReferenceBuffer[] | undefined;
  let gptImageExtraBuffers: ReferenceBuffer[] | undefined;
  if (config.gptImageModel) {
    gptImageRefBuffers = await loadReferenceBuffers(refSources);

    // Also pre-load selected image and user reference as extra buffers
    const selected = await loadSelectedImagePart(options.selectedImagePath, options.selectedImageUrl);
    const userRef = await loadUserReferencePart(options.referenceImagePath, options.referenceImageUrl);
    const extraSources = [...selected.sources, ...userRef.sources];
    gptImageExtraBuffers = await loadReferenceBuffers(extraSources);
  }

  // ── Gemini File API: upload reference files once per batch (no base64) ──
  let allGeminiFileUris: string[] = [];
  if (!config.gptImageModel && config.geminiApiKey) {
    const selected = await loadSelectedImagePart(options.selectedImagePath, options.selectedImageUrl);
    const userRef = await loadUserReferencePart(options.referenceImagePath, options.referenceImageUrl);
    const allSources = [...refSources, ...selected.sources, ...userRef.sources];
    allGeminiFileUris = await uploadImagesToGemini(allSources);
  }

  const isLive = Boolean(config.gptImageModel || config.geminiApiKey || config.nanoBananaApiKey);

  const candidateUrls: Record<string, string> = {};
  let completedCount = 0;

  const tasks = Array.from({ length: count }, async (_, i) => {
    const index = i + 1;
    const fileName = isLive
      ? `candidate-${String(index).padStart(2, "0")}.png`
      : record.format === "gif"
        ? `candidate-${String(index).padStart(2, "0")}.gif`
        : `candidate-${String(index).padStart(2, "0")}.svg`;
    const absolutePath = path.join(trialDirectory, fileName);

    if (isLive) {
      await generateWithNanoBanana(record, absolutePath, { ...options, count }, index, refParts, allGeminiFileUris, gptImageRefBuffers, gptImageExtraBuffers);
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
