export type AgentConnection = {
  id: string;
  name: string;
  kind?: string;
  /** Legacy consumer metadata; connection authentication belongs to its provider. */
  auth?: string;
  revision: string | number;
  available: boolean;
  reason?: string;
  provider?: {
    appId: string;
    installationId: string;
    key: string;
    name?: string;
  };
  capabilities?: string[];
};
