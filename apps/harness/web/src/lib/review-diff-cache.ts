import type { ReviewDiff } from "./workspace-review-api";

export type CachedReviewDiff = { key: string; value: ReviewDiff; bytes: number };
const defaultLimits = { maxEntries: 24, maxBytes: 12 * 1024 * 1024 };

export function retainReviewDiff(entries: readonly CachedReviewDiff[], key: string, value: ReviewDiff,
  limits = defaultLimits): CachedReviewDiff[] {
  const next = entries.filter(entry => entry.key !== key);
  const bytes = JSON.stringify(value).length * 2;
  if (bytes > limits.maxBytes) return next;
  next.push({ key, value, bytes });
  let total = next.reduce((sum, entry) => sum + entry.bytes, 0);
  while (next.length > limits.maxEntries || total > limits.maxBytes) total -= next.shift()!.bytes;
  return next;
}
