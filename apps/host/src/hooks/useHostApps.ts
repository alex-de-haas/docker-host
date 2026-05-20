'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HostAppEntry, HostAppsResponse } from '@/types/apps';

export function useHostApps() {
  const [apps, setApps] = useState<HostAppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing'>('idle');

  const fetchApps = useCallback(async (options?: { suppressLoading?: boolean }) => {
    if (!options?.suppressLoading) {
      setLoading(true);
    }

    try {
      const response = await fetch('/api/apps', {
        cache: 'no-store',
      });
      if (!response.ok) {
        const apiError = await getApiError(response, 'Failed to fetch Host apps');
        throw new HostAppsFetchError(apiError.message, apiError.code);
      }

      const data = await response.json() as HostAppsResponse;
      setApps(Array.isArray(data.apps) ? data.apps : []);
      setError(null);
      setErrorCode(null);
      setLastUpdatedAt(Date.now());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown app registry error');
      setErrorCode(err instanceof HostAppsFetchError ? err.code : null);
      return false;
    } finally {
      setLoading(false);
      setRefreshState('idle');
    }
  }, []);

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  const refetch = useCallback(async () => {
    setRefreshState('refreshing');
    await fetchApps({ suppressLoading: true });
  }, [fetchApps]);

  return {
    apps,
    loading,
    error,
    errorCode,
    lastUpdatedAt,
    refreshState,
    refetch,
  };
}

class HostAppsFetchError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'HostAppsFetchError';
  }
}

async function getApiError(response: Response, fallback: string) {
  try {
    const data = await response.json();
    const code = typeof data?.error?.code === 'string' ? data.error.code : null;
    const details =
      typeof data?.details === 'string'
        ? data.details
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : typeof data?.error === 'string'
            ? data.error
            : null;

    return {
      code,
      message: details ? `${fallback}: ${details}` : fallback,
    };
  } catch {
    return {
      code: null,
      message: fallback,
    };
  }
}
