/** Editable process guidance; Core permissions and worktree safety remain enforced separately. */
export const DEFAULT_WORKFLOW_PROMPT = `For development work, clarify the desired outcome and follow the operator's and repository's instructions. Use a plan when it helps; neither Plans nor a Markdown plan is required.
Implement in registered worktrees, test the affected behavior, and explain results and remaining limitations.
Prepare a sandbox with suitable test data when preview helps. Reuse it across iterations and keep it available for operator review. Finish it only when requested or when the agreed workflow calls for cleanup.
Create commits, push, publish pull requests and merge only with the operator's authorization. Follow CI and review feedback when publication is part of the task.
When the entire task is accepted and every repository is committed and merged, request verified workspace completion. Defer unfinished work; never mark it complete merely because the conversation is inactive. Keep source and previews until an explicit cleanup action or the configured completed-workspace retention policy applies.`;
