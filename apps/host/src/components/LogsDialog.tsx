'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useContainerLogs } from '@/hooks/useDocker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface LogsDialogProps {
  containerId: string | null;
  containerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LogsDialog({ containerId, containerName, open, onOpenChange }: LogsDialogProps) {
  const { logs, loading, refetch } = useContainerLogs(open ? containerId : null);
  const logsRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Logs: {containerName}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={refetch}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex-1 min-h-0"
        >
          <pre
            ref={logsRef}
            className="h-full overflow-auto bg-zinc-950 text-zinc-100 p-4 rounded-lg font-mono text-xs leading-relaxed"
          >
            {loading && !logs ? (
              <span className="text-zinc-500">Loading logs...</span>
            ) : logs ? (
              logs.split('\n').map((line, i) => {
                // Parse timestamp and colorize
                const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s*(.*)/);
                if (match) {
                  return (
                    <div key={i} className="hover:bg-zinc-900">
                      <span className="text-zinc-500">{match[1]}</span>{' '}
                      <span>{match[2]}</span>
                    </div>
                  );
                }
                return (
                  <div key={i} className="hover:bg-zinc-900">
                    {line}
                  </div>
                );
              })
            ) : (
              <span className="text-zinc-500">No logs available</span>
            )}
          </pre>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
