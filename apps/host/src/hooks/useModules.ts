'use client';

import { useCallback, useEffect, useState } from 'react';
import { notifyHostAppsChanged } from '@/hooks/useHostApps';
import type {
  ModuleActionResult,
  ModuleOperationError,
  ModuleRecoveryAction,
  ModuleRecoveryActionResult,
  ModuleRecoveryPlanResponse,
  ModuleSummary,
} from '@/types/modules';

export type ModuleLifecycleAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'retry'
  | 'update-retry'
  | ModuleRecoveryAction;

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
        if (action === 'cleanup' || action === 'remove') {
          throw new Error(`${action} requires a reviewed recovery plan.`);
        }

        const actionPath = action === 'update-retry' ? 'update/retry' : action;
        const response = await fetch(`/api/modules/${encodeURIComponent(id)}/${actionPath}`, {
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
        notifyHostAppsChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown module action error');
      } finally {
        setPendingAction(null);
      }
    },
    [fetchModules]
  );

  const getRecoveryPlan = useCallback(
    async (
      id: string,
      action: ModuleRecoveryAction,
      deleteModuleData: boolean
    ): Promise<ModuleRecoveryPlanResponse> => {
      const response = await fetch(`/api/modules/${encodeURIComponent(id)}/${action}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteModuleData }),
      });
      const data: ModuleRecoveryPlanResponse = await response.json();

      if (!response.ok && !data.plan) {
        throw new Error(formatRecoveryPlanError(data, `Failed to load ${action} plan`));
      }

      return data;
    },
    []
  );

  const applyRecoveryAction = useCallback(
    async (id: string, action: ModuleRecoveryAction, deleteModuleData: boolean) => {
      setPendingAction({ id, action });

      try {
        const response = await fetch(`/api/modules/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true, deleteModuleData }),
        });
        const result: ModuleRecoveryActionResult = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(formatModuleActionError(result.error, `Failed to ${action} module`));
        }

        if (result.removedModuleId) {
          setModules(current => current.filter(module => module.id !== result.removedModuleId));
        }

        setError(null);
        await fetchModules({ suppressLoading: true });
        notifyHostAppsChanged();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown module recovery action error');
        return false;
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
    getRecoveryPlan,
    applyRecoveryAction,
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

function formatRecoveryPlanError(data: ModuleRecoveryPlanResponse, fallback: string) {
  if (!data.error) {
    return fallback;
  }

  return [
    data.error.message,
    ...data.error.conflicts.map(conflict => conflict.message),
  ].filter(Boolean).join(' ');
}
