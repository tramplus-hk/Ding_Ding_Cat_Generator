import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const sourcePath = path.resolve(process.cwd(), "src/routes/stickers.ts");

describe("generation routes", () => {
  test("enqueue durable generation and expose current run", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /stickersRouter\.get\("\/current"/);
    assert.match(source, /randomUUID\(\)/);
    assert.match(source, /await cleanupStaleRuntimeBlobs\(\);/);
    assert.match(source, /writeCurrentRunBlob\(\{ recordId: record\.id, runId \}\)/);
    assert.match(source, /deleteRuntimeAssetsExceptCurrent\(\{ recordId: record\.id, runId \}\)/);
    assert.match(source, /sendGenerationRun\(\{/);
    assert.match(source, /res\.status\(202\)\.json\(withoutCandidatePreviews\(generatingRecord\)\)/);
    assert.doesNotMatch(source, /const generatedRecord = await runGeneration\(record,/);
  });

  test("copies uploaded references into run-scoped storage before enqueue", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /const referenceBody = input\.referenceImageUrl\s+\? await readRuntimeBlob\(input\.referenceImageUrl\)\s+: undefined;/);
    assert.match(source, /const referenceImageUrl = referenceBody\s+\? await uploadRuntimeReferenceBlob\(\s*record\.id,\s*input\.referenceImagePath \?\? input\.referenceImageUrl!,\s*referenceBody,\s*runId,\s*\)\s+: input\.referenceImageUrl;/);
    assert.match(source, /referenceImagePath: input\.referenceImagePath,/);
    assert.match(source, /referenceImageUrl,/);
  });

  test("accept and reject only clear current run for records with a run id", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.equal(source.match(/if \(record\.result\?\.runId\) \{\s*await clearCurrentRunBlob\(\{ recordId: record\.id, runId: record\.result\.runId \}\);\s*\}/g)?.length, 2);
    assert.doesNotMatch(source, /clearCurrentRunBlob\([^)]*undefined/);
  });

  test("current endpoint clears mismatched run ids", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /if \(record\.result\?\.runId !== current\.runId\) \{\s+await clearCurrentRunBlob\(current\);\s+res\.json\(\{ record: null \}\);\s+return;\s+\}/s);
  });
});
