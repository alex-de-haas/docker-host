export type TranscriptReviewReference = {
  sessionId: string; workspaceId: string; worktreeId: string; repository: string; path: string;
};
export type TranscriptFileEdit = {
  path: string; kind: string; additions?: number; deletions?: number;
  review?: TranscriptReviewReference; unavailable?: string;
};
