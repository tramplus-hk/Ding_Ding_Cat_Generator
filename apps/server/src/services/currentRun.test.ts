import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const sourcePath = path.resolve(process.cwd(), "src/services/runtimeBlob.ts");

describe("runtimeBlob current run helpers", () => {
  test("defines current-run helpers and deterministic run-scoped paths", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /export type CurrentRun = \{/);
    assert.match(source, /function currentRunPath\(\): string \{\n\s+return `\$\{runtimeRoot\}\/current\.json`;\n\}/);
    assert.match(source, /export async function readCurrentRunBlob\(\)/);
    assert.match(source, /export async function writeCurrentRunBlob\(/);
    assert.match(source, /export async function clearCurrentRunBlob\(/);
    assert.match(source, /runtime\/generated\/\$\{id\}\/\$\{runId\}\//);
    assert.match(source, /runtime\/uploads\/\$\{id\}\/\$\{runId\}\//);
    assert.match(source, /export async function deleteRuntimeAssetsExceptCurrent\(/);
    assert.match(source, /export async function cleanupStaleRuntimeBlobs\(ttlMs = 24 \* 60 \* 60 \* 1000\)/);
  });

  test("cleanup clears a stale current run pointer instead of preserving its blobs", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /const currentIsFresh = Boolean\(current && Number\.isFinite\(currentUpdatedAt\) && currentUpdatedAt >= cutoff\)/);
    assert.match(source, /if \(current && !currentIsFresh\) \{\s+await del\(currentRunPath\(\)\)\.catch\(\(\) => undefined\);\s+\}/s);
    assert.match(source, /const freshCurrent = currentIsFresh \? current : undefined;/);
    assert.match(source, /const keepGenerated = freshCurrent \? assetPrefix\(freshCurrent\.recordId, freshCurrent\.runId\) : undefined;/);
    assert.match(source, /const keepUploads = freshCurrent \? uploadPrefix\(freshCurrent\.recordId, freshCurrent\.runId\) : undefined;/);
    assert.match(source, /const keepRecord = freshCurrent \? recordPath\(freshCurrent\.recordId\) : undefined;/);
  });
});
