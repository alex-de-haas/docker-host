// Pure execution-scope types shared by browser and server consumers.
export interface SandboxTarget { runtimeInstanceId: string; generation: string; dataRevision: string }
export interface SandboxIdentityContext extends SandboxTarget { identityRealm: "sandbox" | "core"; appRole: string; permissions: string[] }
