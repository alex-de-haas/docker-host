import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { Diff } from "./development-api";

type Preview = { kind: "diff"; file: FileDiffMetadata } | { kind: "text"; message: string; content?: string };

// The local scope returns literal contents only for status ??; newFile also includes staged additions.
export function prepareWorkspaceDiff(diff: Diff, untracked: boolean): Preview {
  if (diff.truncated) return { kind: "text", message: "Diff exceeds the preview limit. Inspect it in your Git client." };
  if (diff.binary || diff.image) return { kind: "text", message: "Binary file changed. Inspect it in your editor." };
  if (!diff.combined) return { kind: "text", message: untracked ? "Empty new file." : "No text changes." };
  try {
    if (untracked) return { kind: "diff", file: parseDiffFromFile(null, { name: diff.path, contents: diff.combined }) };
    const files = parsePatchFiles(diff.combined, undefined, true).flatMap(patch => patch.files);
    if (files.length === 1 && files[0].hunks.length) return { kind: "diff", file: files[0] };
    return { kind: "text", message: "No line changes to display. File metadata is shown below.", content: diff.combined };
  } catch {
    return { kind: "text", message: "This patch could not be rendered. The original preview is shown below.", content: diff.combined };
  }
}
