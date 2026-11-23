export const CHAT_WORKFLOW_PROVIDER = "hosty:chat-workflow";

export const PROFILE_MANAGEMENT_PROVIDER = "hosty:profile-management";

export const isChatWorkflowProvider = (provider: string) => provider === CHAT_WORKFLOW_PROVIDER || provider === PROFILE_MANAGEMENT_PROVIDER;

export const isPrivateToolProvider = (provider: string) => provider === "hosty:development" || isChatWorkflowProvider(provider);
