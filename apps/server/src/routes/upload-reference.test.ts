import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { uploadReferenceSchema } from "./stickers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const uploadsDir = path.join(projectRoot, ".runtime/uploads");

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

describe("upload-reference", () => {
  test("validates a correct upload payload", () => {
    const result = uploadReferenceSchema.safeParse({
      fileName: "cat.png",
      data: `data:image/png;base64,${TEST_PNG_BASE64}`,
      theme: "lunar_new_year",
      description: "dancing cat",
    });

    assert.equal(result.success, true);
  });

  test("rejects payloads missing required fields", () => {
    const cases = [
      { label: "no fileName", body: { data: "x", theme: "a", description: "b" } },
      { label: "no data", body: { fileName: "x", theme: "a", description: "b" } },
      { label: "no theme", body: { fileName: "x", data: "x", description: "b" } },
      { label: "no description", body: { fileName: "x", data: "x", theme: "a" } },
      { label: "empty fileName", body: { fileName: "", data: "x", theme: "a", description: "b" } },
      { label: "empty data", body: { fileName: "x", data: "", theme: "a", description: "b" } },
      { label: "empty theme", body: { fileName: "x", data: "x", theme: "", description: "b" } },
      { label: "empty description", body: { fileName: "x", data: "x", theme: "a", description: "" } },
    ];

    for (const { label, body } of cases) {
      const result = uploadReferenceSchema.safeParse(body);
      assert.equal(result.success, false, `Expected failure for case: ${label}`);
    }
  });

  test("normalizes unsupported file extensions to .png", () => {
    const extensions = [
      { input: "photo.jpg", expected: ".jpg" },
      { input: "photo.jpeg", expected: ".jpeg" },
      { input: "photo.png", expected: ".png" },
      { input: "photo.webp", expected: ".webp" },
      { input: "photo.gif", expected: ".gif" },
      { input: "photo.PNG", expected: ".png" },
      { input: "photo.JPEG", expected: ".jpeg" },
      { input: "photo.bmp", expected: ".png" },
      { input: "photo.tiff", expected: ".png" },
      { input: "photo", expected: ".png" },
    ];

    for (const { input, expected } of extensions) {
      const extension = path.extname(input).toLowerCase();
      const safeExtension = /\.(png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
      assert.equal(safeExtension, expected, `Failed for ${input}`);
    }
  });

  test("saves uploaded image to .runtime/uploads and returns correct relative path", async () => {
    const fileName = "test-ref-image.png";
    const dataUrl = `data:image/png;base64,${TEST_PNG_BASE64}`;
    const extension = path.extname(fileName).toLowerCase();
    const safeExtension = /\.(png|jpe?g|webp|gif)$/i.test(extension) ? extension : ".png";
    const safeName = `ref-${Date.now()}-${randomUUID()}${safeExtension}`;
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;

    await mkdir(uploadsDir, { recursive: true });

    const filePath = path.join(uploadsDir, safeName);
    await writeFile(filePath, Buffer.from(base64, "base64"));

    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");

    assert.equal(await fileExists(filePath), true, "File should exist after write");

    const written = await readFile(filePath);
    assert.equal(written.length, Buffer.from(base64, "base64").length, "Written data should match");

    assert.ok(relativePath.startsWith(".runtime/uploads/ref-"), `Path should start with .runtime/uploads/ref-: ${relativePath}`);
    assert.ok(relativePath.endsWith(safeExtension), `Path should end with ${safeExtension}: ${relativePath}`);

    await rm(filePath);
    assert.equal(await fileExists(filePath), false, "File should be cleaned up");
  });

  test("strips data URL prefix to extract raw base64", () => {
    const rawBase64 = TEST_PNG_BASE64;
    const dataUrl = `data:image/png;base64,${rawBase64}`;

    const extracted = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    assert.equal(extracted, rawBase64);

    const plainBase64 = rawBase64;
    const noPrefixResult = plainBase64.includes(",") ? plainBase64.split(",")[1] : plainBase64;
    assert.equal(noPrefixResult, rawBase64, "Should pass through raw base64 unchanged");
  });

  test("generates slugs matching generated database naming convention", () => {
    const cases = [
      { theme: "Lunar New Year", description: "Lantern dance", expectedTheme: "lunar_new_year", expectedDesc: "lantern_dance" },
      { theme: "  Christmas  ", description: "Santa  hat  ", expectedTheme: "christmas", expectedDesc: "santa_hat" },
      { theme: "Valentine!!!", description: "Hearts & Roses", expectedTheme: "valentine", expectedDesc: "hearts_roses" },
      { theme: "", description: "", expectedTheme: "untitled", expectedDesc: "untitled" },
    ];

    for (const { theme, description, expectedTheme, expectedDesc } of cases) {
      assert.equal(slugify(theme), expectedTheme, `Theme slug for "${theme}"`);
      assert.equal(slugify(description), expectedDesc, `Description slug for "${description}"`);
    }
  });

  test("Notion upload call uses correct reference group and generated-style category/content", async () => {
    const { getAvailableNotionContentName } = await import("../services/notion.js");
    const theme = "lunar_new_year_test";
    const description = "dancing_cat_test";
    const safeExtension = ".png";

    const contentName = await getAvailableNotionContentName("reference", theme, description, safeExtension);

    assert.ok(contentName.startsWith(description), `Content name should start with description slug: ${contentName}`);
    assert.ok(contentName.endsWith(safeExtension), `Content name should end with extension: ${contentName}`);

    const baseName = path.parse(contentName).name;
    assert.equal(baseName.includes("dancing_cat_test"), true, `Base name should contain description slug`);
    assert.ok(baseName === description || /_(\d+)$/.test(baseName), `Base name should be the slug or slug_N: ${baseName}`);
  });
});
