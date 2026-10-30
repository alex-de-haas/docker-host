namespace Haas.Hosty.Core;

internal sealed partial class PullRequestService
{
    internal string CurrentRevision(PullRequestActor actor) { lock (sync) return owners.GetValueOrDefault(actor.UserId)?.Revision ?? ""; }
    private sealed record PendingScope(PullRequestActor Actor, PullRequestScope Scope, DateTimeOffset Expires);
    private readonly Dictionary<string, PendingScope> pendingScopes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingScope> activeScopes = new(StringComparer.Ordinal);
    private bool RepositoryDemand(string userId, string repositoryId) => activeScopes.Values.Any(s => s.Actor.UserId == userId &&
        (s.Scope.AllInstalled || s.Scope.Repositories?.Contains(repositoryId, StringComparer.Ordinal) == true || s.Scope.PullRequests?.Any(p => p.RepositoryId == repositoryId) == true));
    private bool PullRequestDemand(string userId, string repositoryId, int number) => activeScopes.Values.Any(s => s.Actor.UserId == userId &&
        s.Scope.PullRequests?.Any(p => p.RepositoryId == repositoryId && p.Number == number) == true);

    public async Task<PullRequestSubscription> SubscribeAsync(PullRequestActor actor, PullRequestScope scope, CancellationToken ct)
    {
        if (scope.Repositories?.Length > 100 || scope.PullRequests?.Length > 100 || scope.Workspaces?.Length > 50 || scope.Workspaces?.Any(w => w is null || w.Length != 64 || !w.All(char.IsAsciiHexDigit)) == true ||
            scope.Repositories?.Any(r => r is null || r.Length > 128) == true || scope.PullRequests?.Any(p => p is null || p.Number <= 0 || p.RepositoryId is null || p.RepositoryId.Length > 128) == true)
            throw new PullRequestException("pr_scope_invalid", "The PR subscription scope exceeds its limits.", 400);
        await publications.ValidateObservationScopesAsync(actor, scope.Workspaces ?? [], ct, scope.PullRequests?.Distinct().Count() ?? 0);
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            foreach (var old in pendingScopes.Where(p => p.Value.Expires <= clock.UtcNow).Select(p => p.Key).ToArray()) pendingScopes.Remove(old);
            if (pendingScopes.Count(p => p.Value.Actor.UserId == actor.UserId) >= 64 || pendingScopes.Count >= 512)
                throw new PullRequestException("pr_subscription_limit", "Too many pending subscriptions.", 429);
            var allowed = CanonicalRepositories(owner).Where(HasProof).ToArray();
            if (scope.Repositories?.Any(id => !allowed.Any(r => r.Id == id)) == true ||
                scope.PullRequests?.Any(p => !allowed.Any(r => r.Id == p.RepositoryId)) == true)
                throw new PullRequestException("pr_scope_forbidden", "The subscription contains an inaccessible repository.", 403);
            var id = Guid.NewGuid().ToString("N"); var expires = clock.UtcNow.AddSeconds(30);
            pendingScopes[id] = new(actor, scope, expires);
            return new(id, expires);
        }
    }
    public IDisposable Admit(PullRequestActor actor, string id)
    {
        lock (sync)
        {
            if (!pendingScopes.TryGetValue(id, out var pending) || pending.Expires <= clock.UtcNow || pending.Actor != actor)
                throw new PullRequestException("pr_subscription_expired", "Create a new scoped subscription.", 409);
            if (activeScopes.Count >= 256 || activeScopes.Count(p => p.Value.Actor.UserId == actor.UserId) >= 32)
                throw new PullRequestException("pr_subscription_limit", "Too many active PR streams.", 429);
            pendingScopes.Remove(id); activeScopes[id] = pending;
            return new StreamLease(this, id);
        }
    }
    private sealed class StreamLease(PullRequestService service, string id) : IDisposable
    {
        public void Dispose() { lock (service.sync) service.activeScopes.Remove(id); }
    }
    public async Task<PullRequestChanged> StreamStateAsync(PullRequestActor actor, string id, CancellationToken ct)
    {
        PullRequestScope currentScope;
        lock (sync) currentScope = activeScopes.GetValueOrDefault(id)?.Scope ?? new();
        await publications.ValidateObservationScopesAsync(actor, currentScope.Workspaces ?? [], ct, currentScope.PullRequests?.Distinct().Count() ?? 0);
        var owner = await ReconcileAsync(actor, ct);
        lock (sync)
        {
            if (!activeScopes.TryGetValue(id, out var stream) || stream.Actor != actor)
                throw new PullRequestException("pr_subscription_expired", "The PR stream is no longer active.", 409);
            var allowed = CanonicalRepositories(owner).Where(HasProof).Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
            var scope = stream.Scope;
            var repoIds = (scope.AllInstalled ? allowed : (scope.Repositories ?? []).Where(allowed.Contains)).ToArray();
            var refs = (scope.PullRequests ?? []).Where(p => allowed.Contains(p.RepositoryId)).ToArray();
            return new(owner.Revision, repoIds, refs);
        }
    }
}
