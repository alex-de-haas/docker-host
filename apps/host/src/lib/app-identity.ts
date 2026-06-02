import { validateAndNormalizeMetadata } from './module-metadata.ts';
import type { ModuleMetadata } from '@/types/modules';

export function getInstalledUiEndpointKey(metadata: ModuleMetadata | null): string | null {
  const normalizedMetadata = normalizeInstalledIdentityMetadata(metadata);
  const portKey = normalizedMetadata?.ui?.entrypoint?.portKey;
  return typeof portKey === 'string' && portKey.trim() ? portKey.trim() : null;
}

function normalizeInstalledIdentityMetadata(metadata: ModuleMetadata | null) {
  if (!metadata) {
    return null;
  }

  if (metadata.schemaVersion === 'app.0.1') {
    return validateAndNormalizeMetadata(metadata, '$').metadata;
  }

  return metadata;
}
