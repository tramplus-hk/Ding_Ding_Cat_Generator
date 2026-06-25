import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

describe("reference photo upload control", () => {
  test("uses a label associated with a rendered file input", async () => {
    const source = await readFile(new URL("./GeneratePage.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

    assert.match(source, /<label className="upload-button" htmlFor=\{referencePhotoInputId\}>Choose photo<\/label>/);
    assert.match(source, /<input[^>]*id=\{referencePhotoInputId\}[^>]*type="file"/s);
    assert.doesNotMatch(source, /photoInputRef\.current\?\.click\(\)/);
    assert.doesNotMatch(styles, /\.hidden-input\s*\{\s*display:\s*none;\s*\}/);
  });

  test("uses a React-generated id so duplicate upload components do not conflict", async () => {
    const source = await readFile(new URL("./GeneratePage.tsx", import.meta.url), "utf8");

    assert.match(source, /import \{[^}]*\buseId\b[^}]*\} from "react";/);
    assert.match(source, /const referencePhotoInputId = useId\(\);/);
    assert.match(source, /htmlFor=\{referencePhotoInputId\}/);
    assert.match(source, /id=\{referencePhotoInputId\}/);
    assert.doesNotMatch(source, /reference-photo-input/);
  });
});
