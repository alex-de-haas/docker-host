import type {
  HostApiAction,
  HostPrincipal,
  ModuleAccessAssignment,
  ModuleAccessDecision,
  ModuleExposurePolicy,
} from '../types/auth';

export const DEFAULT_MODULE_EXPOSURE_POLICY: ModuleExposurePolicy = 'loginRequired';

export function canUseHostApi(
  principal: HostPrincipal | null | undefined,
  action: HostApiAction
) {
  void action;
  return principal?.role === 'host.admin';
}

export function canAccessModule({
  principal,
  moduleId,
  exposurePolicy = DEFAULT_MODULE_EXPOSURE_POLICY,
  assignments = [],
}: {
  principal?: HostPrincipal | null;
  moduleId: string;
  exposurePolicy?: ModuleExposurePolicy;
  assignments?: Array<ModuleAccessAssignment | string>;
}): ModuleAccessDecision {
  if (exposurePolicy === 'public') {
    return {
      allowed: true,
      policy: exposurePolicy,
      reason: 'public',
    };
  }

  if (!principal) {
    return {
      allowed: false,
      policy: exposurePolicy,
      reason: 'loginRequired',
    };
  }

  if (principal.role === 'host.admin') {
    return {
      allowed: true,
      policy: exposurePolicy,
      reason: 'hostAdmin',
    };
  }

  if (exposurePolicy === 'loginRequired') {
    return {
      allowed: true,
      policy: exposurePolicy,
      reason: 'authenticated',
    };
  }

  if (isAssignedToModule(principal.id, moduleId, assignments)) {
    return {
      allowed: true,
      policy: exposurePolicy,
      reason: 'assigned',
    };
  }

  return {
    allowed: false,
    policy: exposurePolicy,
    reason: 'assignmentRequired',
  };
}

function isAssignedToModule(
  userId: string,
  moduleId: string,
  assignments: Array<ModuleAccessAssignment | string>
) {
  return assignments.some(assignment => {
    if (typeof assignment === 'string') {
      return assignment === userId;
    }

    return assignment.userId === userId && assignment.moduleId === moduleId;
  });
}
