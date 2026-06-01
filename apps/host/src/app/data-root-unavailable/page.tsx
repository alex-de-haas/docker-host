import { AlertTriangle } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function DataRootUnavailablePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <section className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-md border border-destructive/30 bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Docker Host data root unavailable</h1>
            <p className="text-sm text-muted-foreground">The configured data directory is not ready.</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Docker Host will not open setup while the expected data root marker is missing or mismatched.
          Verify the data disk or mount, then recreate the Host container with docker-host restart.
        </p>
      </section>
    </main>
  );
}
