"use client";

export function EmbeddedWorkspacePendingPanel({ error }: { error: string | null }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      {error ? (
        <div className="max-w-lg rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
