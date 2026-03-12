'use client';

import { useState, useEffect, useCallback } from 'react';
import { ContainerStatus, ContainerConfig, ContainerAction, ContainerImageUpdateStatus } from '@/types/docker';

type PendingContainerAction = Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update'>;

export function useContainers() {
  const [containers, setContainers] = useState<ContainerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [lastUpdateCheckAt, setLastUpdateCheckAt] = useState<number | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'self-updating'>('idle');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: PendingContainerAction } | null>(null);
  const [containerUpdateStatuses, setContainerUpdateStatuses] = useState<Record<string, ContainerImageUpdateStatus>>({});

  const fetchContainers = useCallback(async (options?: { suppressError?: boolean }) => {
    const suppressError = options?.suppressError ?? false;

    try {
      const res = await fetch('/api/containers');
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to fetch containers'));
      const data: ContainerStatus[] = await res.json();
      setContainers(data);
      const currentIds = new Set(data.map(container => container.id));
      setContainerUpdateStatuses(current =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => currentIds.has(id))
        )
      );
      setError(null);
      setLastUpdatedAt(Date.now());
      return true;
    } catch (err) {
      if (!suppressError) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
      return false;
    } finally {
      setLoading(false);
      setRefreshState(current => (current === 'self-updating' ? current : 'idle'));
    }
  }, []);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  const refetch = useCallback(async () => {
    setLoading(true);
    setRefreshState('refreshing');
    await fetchContainers();
  }, [fetchContainers]);

  const performAction = async (id: string, action: PendingContainerAction) => {
    setPendingAction({ id, action });
    if (action === 'update') {
      setRefreshState('refreshing');
    }

    let shouldClearPendingAction = true;

    try {
      const res = await fetch('/api/containers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, `Failed to ${action} container`));
      const result = await res.json().catch(() => null);

      if (action === 'update' && result?.selfUpdateScheduled) {
        setError(null);
        setRefreshState('self-updating');
        setContainerUpdateStatuses(current => ({
          ...current,
          [id]: {
            ...(current[id] ?? {
              id,
              image: containers.find(container => container.id === id)?.image || '',
            }),
            updateAvailable: false,
            status: 'up-to-date',
          },
        }));
        shouldClearPendingAction = false;
        void waitForSelfUpdate();
        return;
      }

      if (action === 'update') {
        setContainerUpdateStatuses(current => ({
          ...current,
          [id]: {
            ...(current[id] ?? {
              id,
              image: containers.find(container => container.id === id)?.image || '',
            }),
            updateAvailable: false,
            status: 'up-to-date',
          },
        }));
      }

      if (action === 'update') {
        setLoading(true);
      }

      await fetchContainers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setRefreshState('idle');
      setLoading(false);
    } finally {
      if (shouldClearPendingAction) {
        setPendingAction(null);
      }
    }
  };

  const removeContainer = async (id: string, force: boolean = false) => {
    try {
      const res = await fetch(`/api/containers?id=${id}&force=${force}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to remove container'));
      setContainerUpdateStatuses(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await fetchContainers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const createContainer = async (config: ContainerConfig) => {
    try {
      const res = await fetch('/api/containers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to create container'));
      await fetchContainers();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  };

  const checkForUpdates = async () => {
    setCheckingUpdates(true);

    try {
      const res = await fetch('/api/containers/check-updates', {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await getApiErrorMessage(res, 'Failed to check for updates'));

      const data: { updates: ContainerImageUpdateStatus[] } = await res.json();
      setContainerUpdateStatuses(
        Object.fromEntries(data.updates.map(update => [update.id, update]))
      );
      setLastUpdateCheckAt(Date.now());
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setCheckingUpdates(false);
    }
  };

  const availableUpdateCount = Object.values(containerUpdateStatuses).filter(update => update.updateAvailable).length;

  return {
    containers,
    loading,
    error,
    lastUpdatedAt,
    lastUpdateCheckAt,
    refreshState,
    checkingUpdates,
    pendingAction,
    containerUpdateStatuses,
    availableUpdateCount,
    refetch,
    checkForUpdates,
    performAction,
    removeContainer,
    createContainer,
  };

  async function waitForSelfUpdate() {
    setLoading(true);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(attempt === 0 ? 6_000 : 2_000);

      const recovered = await fetchContainers({ suppressError: true });
      if (recovered) {
        setPendingAction(null);
        return;
      }
    }

    setLoading(false);
    setRefreshState('idle');
    setPendingAction(null);
    setError('Self-update is still in progress. Refresh the page in a few seconds.');
  }
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function useContainerLogs(containerId: string | null) {
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!containerId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/containers/${containerId}?logs=true&tail=200`);
      if (!res.ok) throw new Error('Failed to fetch logs');
      const data = await res.json();
      setLogs(data.logs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [containerId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return { logs, loading, refetch: fetchLogs };
}
