export const CHAT_WORKFLOW_PROVIDER = "hosty:chat-workflow";

export const isPrivateToolProvider = (provider: string) => provider === "hosty:development" || provider === CHAT_WORKFLOW_PROVIDER;
