import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const sourcePath = path.resolve(process.cwd(), "src/services/generationJobs.ts");

describe("generationJobs", () => {
  test("defines Inngest client, event sender, and stale run guards", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /new Inngest\(\{ id: "sticker-generation" \}\)/);
    assert.match(source, /export async function sendGenerationRun\(/);
    assert.match(source, /name: "sticker\/generation\.run"/);
    assert.match(source, /export async function applyCandidateSuccess\(/);
    assert.match(source, /export async function applyCandidateFailure\(/);
    assert.match(source, /current\.recordId !== recordId \|\| current\.runId !== runId/);
    assert.match(source, /record\.result\?\.runId !== runId/);
    assert.match(source, /generationFunctions = \[/);
  });

  test("guards stale runs immediately before candidate writes", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /beforeWrite: \(\) => isCurrentRun\(input\.recordId, input\.runId\)/);
  });

  test("generates candidate results sequentially inside one Inngest run", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /for \(const candidateIndex of candidateIndexes\) \{/);
    assert.match(source, /await step\.run\(`candidate-\$\{candidateIndex\}`/);
    assert.doesNotMatch(source, /Promise\.all\(candidateIndexes\.map/);
    assert.doesNotMatch(source, /recordMutationQueues/);
  });

  test("registers a scheduled stale runtime cleanup function", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /cleanupStaleRuntimeBlobs/);
    assert.match(source, /id: "cleanup-stale-runtime-blobs"/);
    assert.match(source, /cron: "0 \* \* \* \*"/);
    assert.match(source, /generationFunctions = \[generateCandidate, cleanupStaleRuntime\]/);
  });

  test("marks mixed candidate completion as generated", async () => {
    const source = await readFile(sourcePath, "utf8");

    assert.match(source, /function getCandidateCompletionStatus\(/);
    assert.match(source, /completedCount >= requestedCandidateCount/);
    assert.match(source, /return successCount > 0 \? "generated" : "failed"/);
  });

  test("app mounts the Inngest endpoint", async () => {
    const appSource = await readFile(path.resolve(process.cwd(), "src/app.ts"), "utf8");

    assert.match(appSource, /import \{ serve \} from "inngest\/express";/);
    assert.match(appSource, /app\.use\("\/api\/inngest", serve\(\{ client: inngest, functions: generationFunctions \}\)\);/);
  });
});
