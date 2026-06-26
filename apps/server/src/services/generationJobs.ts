import type { StickerRecord } from "@sticker-platform/shared";
import { Inngest } from "inngest";
import { generateStickerCandidate, type GenerateOptions, type GeneratedCandidate } from "./imageGeneration.js";
import { getStickerRecord, updateStickerRecord } from "./stickerStorage.js";
import { cleanupStaleRuntimeBlobs, readCurrentRunBlob } from "./runtimeBlob.js";

export const inngest = new Inngest({ id: "sticker-generation" });

export type GenerationRunEventData = {
  recordId: string;
  runId: string;
  mode: "generate" | "refine";
  count: number;
  referenceImagePath?: string;
  referenceImageUrl?: string;
  selectedImagePath?: string;
  selectedImageUrl?: string;
  refinementRequirement?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isCurrentRun(recordId: string, runId: string): Promise<boolean> {
  const current = await readCurrentRunBlob();
  if (current && (current.recordId !== recordId || current.runId !== runId)) {
    return false;
  }

  const record = await getStickerRecord(recordId);
  return Boolean(record && record.result?.runId === runId);
}

function candidateKey(index: number): string {
  return `candidate-${String(index).padStart(2, "0")}`;
}

function sortCandidates(candidates: string[]): string[] {
  return [...new Set(candidates)].sort((a, b) => a.localeCompare(b));
}

function getCandidateCompletionStatus(successCount: number, failureCount: number, requestedCandidateCount: number): StickerRecord["status"] {
  const completedCount = successCount + failureCount;

  if (completedCount >= requestedCandidateCount) {
    return successCount > 0 ? "generated" : "failed";
  }

  return "generating";
}

export async function applyCandidateSuccess(
  recordId: string,
  runId: string,
  candidate: GeneratedCandidate,
  requestedCandidateCount: number,
): Promise<StickerRecord | undefined> {
  if (!(await isCurrentRun(recordId, runId))) return undefined;

  const record = await getStickerRecord(recordId);
  if (!record || record.result?.runId !== runId) return undefined;

  const candidatesByIndex = new Map<string, string>();
  for (const existing of record.result.candidates ?? []) {
    const match = existing.match(/candidate-(\d+)\.[a-z0-9]+$/i);
    if (match) candidatesByIndex.set(match[1], existing);
  }
  candidatesByIndex.set(String(candidate.index).padStart(2, "0"), candidate.candidatePath);

  const candidates = sortCandidates([...candidatesByIndex.values()]);
  const candidateUrls = { ...(record.result.candidateUrls ?? {}) };
  if (candidate.blobPathname) {
    candidateUrls[candidate.candidatePath] = candidate.blobPathname;
  }

  const candidateErrors = record.result.candidateErrors ?? {};
  const status = getCandidateCompletionStatus(candidates.length, Object.keys(candidateErrors).length, requestedCandidateCount);
  return updateStickerRecord(recordId, {
    status,
    error: status === "failed" ? record.error : undefined,
    result: {
      ...record.result,
      runId,
      candidates,
      candidateUrls,
      localPath: record.result.localPath ?? candidates[0],
      selectedPath: record.result.selectedPath ?? candidates[0],
      requestedCandidateCount,
    },
  });
}

export async function applyCandidateFailure(
  recordId: string,
  runId: string,
  candidateIndex: number,
  error: unknown,
  requestedCandidateCount: number,
): Promise<StickerRecord | undefined> {
  if (!(await isCurrentRun(recordId, runId))) return undefined;

  const record = await getStickerRecord(recordId);
  if (!record || record.result?.runId !== runId) return undefined;

  const candidateErrors = {
    ...(record.result.candidateErrors ?? {}),
    [candidateKey(candidateIndex)]: getErrorMessage(error),
  };
  const candidates = record.result.candidates ?? [];
  const status = getCandidateCompletionStatus(candidates.length, Object.keys(candidateErrors).length, requestedCandidateCount);

  return updateStickerRecord(recordId, {
    status,
    error: status === "failed" ? getErrorMessage(error) : undefined,
    result: {
      ...record.result,
      runId,
      candidateErrors,
      requestedCandidateCount,
    },
  });
}

export async function sendGenerationRun(input: GenerationRunEventData): Promise<void> {
  await inngest.send({ name: "sticker/generation.run", data: input });
}

const generateCandidate = inngest.createFunction(
  { id: "generate-sticker-candidates", triggers: [{ event: "sticker/generation.run" }] },
  async ({ event, step }) => {
    const input = event.data as GenerationRunEventData;
    const candidateIndexes = Array.from({ length: input.count }, (_, index) => index + 1);

    for (const candidateIndex of candidateIndexes) {
      await step.run(`candidate-${candidateIndex}`, async () => {
        const record = await getStickerRecord(input.recordId);
        if (!record || record.result?.runId !== input.runId) return;

        const options: GenerateOptions & { count: number; runId: string; candidateIndex: number } = {
          count: input.count,
          runId: input.runId,
          candidateIndex,
          referenceImagePath: input.referenceImagePath,
          referenceImageUrl: input.referenceImageUrl,
          selectedImagePath: input.selectedImagePath,
          selectedImageUrl: input.selectedImageUrl,
          refinementRequirement: input.refinementRequirement,
          beforeWrite: () => isCurrentRun(input.recordId, input.runId),
        };

        try {
          const candidate = await generateStickerCandidate(record, options);
          await applyCandidateSuccess(input.recordId, input.runId, candidate, input.count);
        } catch (error) {
          await applyCandidateFailure(input.recordId, input.runId, candidateIndex, error, input.count);
        }
      });
    }
  },
);

const cleanupStaleRuntime = inngest.createFunction(
  { id: "cleanup-stale-runtime-blobs", triggers: [{ cron: "0 * * * *" }] },
  async () => {
    await cleanupStaleRuntimeBlobs();
  },
);

export const generationFunctions = [generateCandidate, cleanupStaleRuntime];
