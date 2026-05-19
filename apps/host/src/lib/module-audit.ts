import { appendAuthAuditEvent } from './auth-store.ts';
import type { AuthRequestMeta } from './auth-service.ts';

export async function appendModuleOperationAudit(input: {
  operation: string;
  moduleId?: string;
  actorUserId?: string;
  success: boolean;
  httpStatus?: number;
  request?: AuthRequestMeta;
  details?: Record<string, unknown>;
}) {
  await appendAuthAuditEvent({
    type: `module.${input.operation}`,
    actorUserId: input.actorUserId,
    target: input.moduleId
      ? {
          type: 'module',
          id: input.moduleId,
        }
      : undefined,
    success: input.success,
    request: input.request,
    details: {
      httpStatus: input.httpStatus,
      ...input.details,
    },
  });
}
