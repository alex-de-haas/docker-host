export type HostRole = 'host.admin' | 'host.user';

export type ModuleExposurePolicy = 'public' | 'loginRequired' | 'assignedUsersOnly';

export type HostApiAction =
  | 'host.read'
  | 'host.configure'
  | 'host.auth.configure'
  | 'host.users.manage'
  | 'modules.install'
  | 'modules.update'
  | 'modules.remove'
  | 'modules.lifecycle'
  | 'modules.exposure.manage'
  | 'modules.recovery';

export interface HostPrincipal {
  id: string;
  role: HostRole;
  email?: string;
  displayName?: string;
}

export interface ModuleAccessAssignment {
  moduleId: string;
  userId: string;
}

export type ModuleAccessReason =
  | 'public'
  | 'authenticated'
  | 'assigned'
  | 'hostAdmin'
  | 'loginRequired'
  | 'assignmentRequired';

export interface ModuleAccessDecision {
  allowed: boolean;
  policy: ModuleExposurePolicy;
  reason: ModuleAccessReason;
}

