import type { ManualImportCandidate } from "../../shared/fixer-types.js";

const SAMPLE_WORD = /(^|[.\-_\s()[\]])sample([.\-_\s()[\]]|$)/i;
const SAMPLE_SIZE_BYTES = 80 * 1024 * 1024;

export function detectLikelySample(input: {
  path?: string;
  relativePath?: string;
  name?: string;
  size?: number;
}): Pick<ManualImportCandidate, "isLikelySample" | "sampleReason"> {
  const text = [input.path, input.relativePath, input.name].filter(Boolean).join(" ");

  if (SAMPLE_WORD.test(text)) {
    return { isLikelySample: true, sampleReason: "filename contains sample" };
  }

  if (typeof input.size === "number" && input.size > 0 && input.size < SAMPLE_SIZE_BYTES) {
    return { isLikelySample: true, sampleReason: "file is smaller than 80 MiB" };
  }

  return { isLikelySample: false };
}
