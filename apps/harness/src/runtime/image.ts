// A release owns this image. Operators install it explicitly; model input never selects an image.
export const WORKER_IMAGE = "ghcr.io/alex-de-haas/hosty-agent-worker:0.54.1";
export const WORKER_LIMITS = { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 512, diskBytes: 20 * 1024 ** 3 } as const;
