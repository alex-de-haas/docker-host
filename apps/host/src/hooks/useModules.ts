'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ModuleActionResult, ModuleOperationError, ModuleSummary } from '@/types/modules';

export type ModuleLifecycleAction = 'start' | 'stop' | 'restart';

export function useModules() {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing'>('idle');
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    action: ModuleLifecycleAction;
  } | null>(null);

  const fetchModules = useCallback(async (options?: { suppressLoading?: boolean }) => {
    if (!options?.suppressLoading) {
      setLoading(true);
    }

    try {
      const response = await fetch('/api/modules');
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, 'Failed to fetch installed modules'));
      }

      const data: { modules: ModuleSummary[] } = await response.json();
      setModules(data.modules);
      setError(null);
      setLastUpdatedAt(Date.now());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown module API error');
      return false;
    } finally {
      setLoading(false);
      setRefreshState('idle');
    }
  }, []);

  useEffect(() => {
    void fetchModules();
  }, [fetchModules]);

  const refetch = useCallback(async () => {
    setRefreshState('refreshing');
    await fetchModules();
  }, [fetchModules]);

  const performAction = useCallback(
    async (id: string, action: ModuleLifecycleAction) => {
      setPendingAction({ id, action });

      try {
        const response = await fetch(`/api/modules/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
        });
        const result: ModuleActionResult = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(formatModuleActionError(result.error, `Failed to ${action} module`));
        }

        if (result.module) {
          setModules(current =>
            current.map(module => (module.id === id ? result.module as ModuleSummary : module))
          );
        }

        setError(null);
        await fetchModules({ suppressLoading: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown module action error');
      } finally {
        setPendingAction(null);
      }
    },
    [fetchModules]
  );

  return {
    modules,
    loading,
    error,
    lastUpdatedAt,
    refreshState,
    pendingAction,
    refetch,
    performAction,
  };
}

async function getApiErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    const details =
      typeof data?.details === 'string'
        ? data.details
        : typeof data?.error === 'string'
          ? data.error
          : null;

    return details ? `${fallback}: ${details}` : fallback;
  } catch {
    return fallback;
  }
}

function formatModuleActionError(error: ModuleOperationError | null, fallback: string) {
  if (!error) {
    return fallback;
  }

  return [error.message, error.dockerMessage, error.nextStep].filter(Boolean).join(' ');
}
