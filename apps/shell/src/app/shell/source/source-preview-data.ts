export type SourceLineStats = { additions: number; deletions: number };
export type SourceImageSide = { dataUrl: string | null; message: string | null };
export type SourceDiff = {
  path: string; combined: string; staged: string; truncated: boolean; head: string | null; newFile: boolean;
  binary?: boolean;
  image?: { before: SourceImageSide | null; after: SourceImageSide | null } | null;
};

export function isSourceImageDataUrl(value: string | null): boolean {
  return value !== null && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function isBinarySourceDiff(diff: SourceDiff, untracked: boolean): boolean {
  if (diff.binary !== undefined) return diff.binary;
  // Older Core versions identify binary data through Git output or the untracked sentinel.
  if (untracked) return diff.combined === "New binary file";
  return [diff.combined, diff.staged].some((patch) => /^(?:Binary files .+ differ|GIT binary patch)$/m.test(patch));
}
