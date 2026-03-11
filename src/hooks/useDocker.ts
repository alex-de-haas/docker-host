'use client';

import { useState, useEffect, useCallback } from 'react';
import { ContainerStatus, ContainerConfig, ContainerAction } from '@/types/docker';

export function useContainers() {
  const [containers, setContainers] = useState<ContainerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      const res = await fetch('/api/containers');
      if (!res.ok) throw new Error('Failed to fetch containers');
      const data = await res.json();
      setContainers(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers();
    const interval = setInterval(fetchContainers, 5000);
    return () => clearInterval(interval);
  }, [fetchContainers]);

  const performAction = async (id: string, action: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update'>) => {
    try {
      const res = await fetch('/api/containers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error(`Failed to ${action} container`);
      await fetchContainers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const removeContainer = async (id: string, force: boolean = false) => {
    try {
      const res = await fetch(`/api/containers?id=${id}&force=${force}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to remove container');
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
      if (!res.ok) throw new Error('Failed to create container');
      await fetchContainers();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  };

  return {
    containers,
    loading,
    error,
    refetch: fetchContainers,
    performAction,
    removeContainer,
    createContainer,
  };
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
