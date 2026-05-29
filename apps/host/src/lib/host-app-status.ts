import type { HostAppStatusReason } from '@/types/apps';

export function formatAppStatusReason(reason: HostAppStatusReason) {
  switch (reason) {
    case 'metadataMissing':
      return 'App metadata is missing.';
    case 'metadataInvalid':
      return 'App metadata is invalid.';
    case 'uiPortMissing':
      return 'App UI needs a published Host port. Open the module update review or reinstall the module.';
    case 'uiPortNotPublic':
      return 'App UI port is not marked public.';
    case 'moduleOperationUnavailable':
      return 'Module operation is not ready.';
    case 'runtimeUnavailable':
      return 'Module runtime is not running.';
    case 'available':
      return 'App is available.';
    default:
      return 'App is unavailable.';
  }
}

export function formatAppStatusReasonLabel(reason: HostAppStatusReason) {
  switch (reason) {
    case 'metadataMissing':
      return 'Metadata missing';
    case 'metadataInvalid':
      return 'Invalid metadata';
    case 'uiPortMissing':
      return 'UI port missing';
    case 'uiPortNotPublic':
      return 'UI port not public';
    case 'moduleOperationUnavailable':
      return 'Operation not ready';
    case 'runtimeUnavailable':
      return 'Runtime not running';
    case 'available':
      return 'Available';
    default:
      return 'Unavailable';
  }
}
