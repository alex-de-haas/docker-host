import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { AuthAuditEvent } from './auth-store.ts';
import { appendAuthAuditEvent } from './auth-store.ts';

export interface AuthAuditQuery {
  cursor?: number;
  limit?: number;
  type?: string;
  actorUserId?: string;
  success?: boolean;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export interface AuthAuditPage {
  events: AuthAuditEvent[];
  nextCursor?: number;
  malformedLineCount: number;
  scannedLineCount: number;
}

export interface AuthAuditPurgeResult {
  retentionDays: number;
  cutoff: string;
  keptCount: number;
  deletedCount: number;
  malformedLineCount: number;
}

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;

export async function listAuthAuditEvents(
  query: AuthAuditQuery = {},
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<AuthAuditPage> {
  if (!(await pathExists(config.authAuditPath))) {
    return {
      events: [],
      malformedLineCount: 0,
      scannedLineCount: 0,
    };
  }

  const limit = clampLimit(query.limit);
  const cursor = Math.max(0, Math.floor(query.cursor ?? 0));
  const filters = normalizeAuditFilters(query);
  const events: AuthAuditEvent[] = [];
  let malformedLineCount = 0;
  let scannedLineCount = 0;
  let matchingIndex = 0;
  let hasMore = false;

  const lines = createInterface({
    input: fs.createReadStream(config.authAuditPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    scannedLineCount += 1;

    const event = parseAuditLine(line);
    if (!event) {
      malformedLineCount += 1;
      continue;
    }

    if (!matchesAuditFilters(event, filters)) {
      continue;
    }

    if (matchingIndex++ < cursor) {
      continue;
    }

    if (events.length >= limit) {
      hasMore = true;
      break;
    }

    events.push(event);
  }

  return {
    events,
    nextCursor: hasMore ? cursor + events.length : undefined,
    malformedLineCount,
    scannedLineCount,
  };
}

export async function purgeAuthAuditEvents(
  input: {
    retentionDays?: number;
    actorUserId?: string;
  } = {},
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<AuthAuditPurgeResult> {
  const retentionDays = clampRetentionDays(input.retentionDays);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffTime).toISOString();
  let keptCount = 0;
  let deletedCount = 0;
  let malformedLineCount = 0;
  const temporaryPath = `${config.authAuditPath}.${process.pid}.${randomUUID()}.tmp`;

  await fsPromises.mkdir(config.authRootContainer, { recursive: true });
  const output = fs.createWriteStream(temporaryPath, { encoding: 'utf-8' });
  if (await pathExists(config.authAuditPath)) {
    const lines = createInterface({
      input: fs.createReadStream(config.authAuditPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    try {
      for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const event = parseAuditLine(line);
        if (!event) {
          malformedLineCount += 1;
          deletedCount += 1;
          continue;
        }

        if (Date.parse(event.createdAt) >= cutoffTime) {
          await writeAuditLine(output, JSON.stringify(event));
          keptCount += 1;
        } else {
          deletedCount += 1;
        }
      }
    } catch (error) {
      output.destroy();
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  await closeAuditWriter(output);
  await fsPromises.rename(temporaryPath, config.authAuditPath);

  await appendAuthAuditEvent({
    type: 'auth.audit.purged',
    actorUserId: input.actorUserId,
    target: {
      type: 'auth.audit',
      id: 'audit.ndjson',
    },
    success: true,
    details: {
      retentionDays,
      cutoff,
      deletedCount,
      keptCount,
      malformedLineCount,
    },
  }, config);

  return {
    retentionDays,
    cutoff,
    keptCount: keptCount + 1,
    deletedCount,
    malformedLineCount,
  };
}

async function writeAuditLine(output: fs.WriteStream, line: string) {
  if (!output.write(`${line}\n`)) {
    await once(output, 'drain');
  }
}

async function closeAuditWriter(output: fs.WriteStream) {
  if (output.closed || output.destroyed) {
    return;
  }

  const closed = once(output, 'close');
  output.end();
  await closed;
}

function parseAuditLine(line: string): AuthAuditEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isAuditEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAuditFilters(query: AuthAuditQuery) {
  return {
    ...query,
    fromTime: parseOptionalTime(query.from),
    toTime: parseOptionalTime(query.to),
  };
}

function matchesAuditFilters(
  event: AuthAuditEvent,
  filters: AuthAuditQuery & { fromTime?: number; toTime?: number }
) {
  if (filters.type && event.type !== filters.type) {
    return false;
  }

  if (filters.actorUserId && event.actorUserId !== filters.actorUserId) {
    return false;
  }

  if (filters.success !== undefined && event.success !== filters.success) {
    return false;
  }

  if (filters.targetType && event.target?.type !== filters.targetType) {
    return false;
  }

  if (filters.targetId && event.target?.id !== filters.targetId) {
    return false;
  }

  const eventTime = Date.parse(event.createdAt);
  if (Number.isNaN(eventTime)) {
    return false;
  }

  if (filters.fromTime !== undefined && eventTime < filters.fromTime) {
    return false;
  }

  if (filters.toTime !== undefined && eventTime > filters.toTime) {
    return false;
  }

  return true;
}

function parseOptionalTime(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function clampLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_AUDIT_LIMIT;
  }

  return Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampRetentionDays(retentionDays: number | undefined) {
  if (retentionDays === undefined || !Number.isFinite(retentionDays)) {
    return 90;
  }

  return Math.min(3650, Math.max(1, Math.floor(retentionDays)));
}

function isAuditEvent(value: unknown): value is AuthAuditEvent {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.actorUserId === undefined || typeof value.actorUserId === 'string') &&
    (value.success === undefined || typeof value.success === 'boolean') &&
    (value.request === undefined || isAuditRequest(value.request)) &&
    (value.target === undefined || isAuditTarget(value.target)) &&
    (value.details === undefined || isObject(value.details));
}

function isAuditRequest(value: unknown): value is { origin?: string; userAgent?: string } {
  return isObject(value) &&
    (value.origin === undefined || typeof value.origin === 'string') &&
    (value.userAgent === undefined || typeof value.userAgent === 'string');
}

function isAuditTarget(value: unknown): value is { type: string; id: string } {
  return isObject(value) &&
    typeof value.type === 'string' &&
    typeof value.id === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
