import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export type SourceDiffInput = {
  path: string;
  content: string;
  untracked?: boolean;
  truncated: boolean;
};

type SourceDiffPreview =
  | { kind: "diff"; file: FileDiffMetadata }
  | { kind: "text"; message: string };

export function prepareSourceDiff({ path, content, untracked, truncated }: SourceDiffInput): SourceDiffPreview {
  if (truncated) return { kind: "text", message: "Showing the available preview as plain text because it was truncated." };
  if (!content) return { kind: "text", message: untracked ? "Empty new file." : "No difference to display." };
  // Core returns raw contents for untracked files, including this binary sentinel.
  if (untracked && content === "New binary file") return { kind: "text", message: "New binary file." };

  try {
    if (untracked) {
      return { kind: "diff", file: parseDiffFromFile(null, { name: path, contents: content }) };
    }
    const files = parsePatchFiles(content, undefined, true).flatMap((patch) => patch.files);
    if (files.length === 1 && files[0].hunks.length > 0) return { kind: "diff", file: files[0] };
    return { kind: "text", message: "No line changes to display. File metadata is shown below." };
  } catch {
    return { kind: "text", message: "This patch could not be rendered. The original preview is shown below." };
  }
}
