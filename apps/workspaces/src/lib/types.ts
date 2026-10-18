export type Operation = { id: string; kind: string; state: string; error?: string | null };
export type FileChange = { path: string; status: string; binary?: boolean };
export type Observation = { at: string; state: string; head?: string | null; targetHead?: string | null; ahead?: number | null; behind?: number | null;
  conflict: boolean; error?: string | null; sessionFiles?: string[] | null; local?: { files: FileChange[]; truncated: boolean } | null };
export type AppBinding = { appId: string; name: string; subpath: string | null; installed: boolean };
export type PullRequest = { url: string; publishedHead: string | null; unavailable: string | null; observation: {
  at: string; state: string; head?: string; draft: boolean; mergeState?: string; reviewDecision?: string; unresolvedThreads: number;
  complete: boolean; error?: string; checks?: { name: string; state: string }[];
} | null };
export type Worktree = { id: string; workspaceId: string; repository: string; branch: string; targetBranch: string; originalBase: string;
  integrationBase: string; path: string; state: string; apps: AppBinding[]; observation: Observation | null;
  sessionChanges: FileChange[]; operations: Operation[]; leases: string[]; pullRequests: PullRequest[]; consumers: { kind: string; reference: string }[];
  commits: { sha: string; author: string; at: string; subject: string }[]; commitsTruncated: boolean; detailError: string | null };
export type Workspace = { id: string; state: string; owner: { kind: string; label: string; reference: string; appId: string | null;
  sessionUrl: string | null; sessionUnavailable: string | null }; worktrees: Worktree[] };
export type Inventory = { workspaces: Workspace[]; observedAt: string };
export type Diff = { path: string; combined: string; staged: string; truncated: boolean; head: string | null; newFile: boolean; binary: boolean; image?: unknown };
