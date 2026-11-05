using HostySdk.App;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreDecisionTests
{
    [Fact]
    public async Task ConcurrentAnswersCommitExactlyOneResolutionAndDeliveryAcrossRestart()
    {
        using var f = await Fixture.Create(); var create = Input();
        var row = await f.Service.CreateAsync(f.Source, create);
        var commands = new[] { Resolve("yes"), Resolve("no") };
        var attempts = await Task.WhenAll(commands.Select(async command =>
        {
            try { return await f.Service.ResolveAsync(f.Owner, row.Id, command); }
            catch (CoreProviderException ex) { Assert.Equal(409, ex.Status); return null; }
        }));
        var winner = Assert.Single(attempts.OfType<HostyDecisionRecord>());
        f.Restart();
        var recovered = await f.Service.GetAsync(f.Owner, row.Id);
        Assert.Equal(CoreJson.Text(winner), CoreJson.Text(recovered));
        Assert.Equal(row.Id, Assert.Single((await f.Service.QueryAsync(f.Source, new(), true)).Items).Id);
        var winnerCommand = commands[Array.FindIndex(attempts, a => a is not null)];
        Assert.Equal(CoreJson.Text(winner), CoreJson.Text(await f.Service.ResolveAsync(f.Owner, row.Id, winnerCommand)));
        await Conflict(() => f.Service.ResolveAsync(f.Owner, row.Id, winnerCommand with { Answers = Answers("changed") }));
        var ack = new HostyDecisionAck(Id(), winner.Resolution!.Revision);
        var received = await f.Service.AckAsync(f.Source, row.Id, ack);
        Assert.Equal("received", received.Continuation!.State);
        f.Restart();
        Assert.Empty((await f.Service.QueryAsync(f.Source, new(), true)).Items);
        Assert.Equal(CoreJson.Text(received), CoreJson.Text(await f.Service.AckAsync(f.Source, row.Id, ack)));
        Assert.Equal(CoreJson.Text(row), CoreJson.Text(await f.Service.CreateAsync(f.Source, create)));
    }

    [Fact]
    public async Task CurrentAccessDoesNotInheritAdministratorOrAnotherInstallationRights()
    {
        using var f = await Fixture.Create(); var row = await f.Service.CreateAsync(f.Source, Input());
        Assert.Empty((await f.Service.QueryAsync(f.Other, new())).Items);
        Assert.Equal(0, (await f.Service.QueryAsync(f.Other, new())).PendingCount);
        await Missing(() => f.Service.GetAsync(f.Other, row.Id));
        await Missing(() => f.Service.ResolveAsync(f.Other, row.Id, Resolve()));
        // A different application may render the user's inbox, but is never the response recipient.
        var otherApp = f.Source with { App = f.App with { Id = "independent.viewer" } };
        Assert.Empty((await f.Service.QueryAsync(otherApp, new(), true)).Items);
        Assert.Equal(0, (await f.Service.QueryAsync(otherApp, new(), true)).PendingCount);
        await Missing(() => f.Service.WithdrawAsync(otherApp, row.Id, new(Id(), 1, "cancel")));
        await f.Users.UpdateAsync(state => state with { Assignments = [] });
        await Missing(() => f.Service.GetAsync(f.Owner, row.Id));
        Assert.Equal(0, (await f.Service.QueryAsync(f.Owner, new())).PendingCount);
        await f.Users.UpdateAsync(state => state with { Assignments = [new(f.App.Id, f.Owner.User.Id, f.Clock.UtcNow)] });
        await f.Registry.UpsertAppAsync(f.App with { InstalledAt = f.App.InstalledAt.AddSeconds(1) });
        await Missing(() => f.Service.GetAsync(f.Owner, row.Id));
    }

    [Fact]
    public async Task DirectClientWorksWithAnEmptyRegistryAndRequiresItsOwnScope()
    {
        using var f = await Fixture.Create(registerApp: false);
        var row = await f.Service.CreateAsync(f.Owner, Input());
        Assert.Equal(row.Id, Assert.Single((await f.Service.QueryAsync(f.Owner, new())).Items).Id);
        var noGrant = f.Owner with { OperatorSession = false, Scopes = [AccessTokenScopes.McpRead] };
        await Assert.ThrowsAsync<AppIdentityException>(() => f.Service.GetAsync(noGrant, row.Id));
        var scoped = noGrant with { Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpDecisions] };
        Assert.Equal("answered", (await f.Service.ResolveAsync(scoped, row.Id, Resolve())).State);
    }

    [Fact]
    public async Task DeadlineAndStalenessRejectLateAnswersWithoutErasingTheirSnapshot()
    {
        using var f = await Fixture.Create(); var create = Input();
        create = create with { Input = create.Input with { ExpiresAt = f.Clock.UtcNow.AddMinutes(1) } };
        var row = await f.Service.CreateAsync(f.Source, create);
        f.Clock.UtcNow = f.Clock.UtcNow.AddMinutes(2);
        await Conflict(() => f.Service.ResolveAsync(f.Owner, row.Id, Resolve()));
        Assert.Equal("expired", (await f.Service.GetAsync(f.Owner, row.Id)).State);
        Assert.Equal(row.Id, (await f.Service.CreateAsync(f.Source, create)).Id);
        row = await f.Service.CreateAsync(f.Source, Input());
        var stale = await f.Service.WithdrawAsync(f.Source, row.Id, new(Id(), 1, "Inputs changed", "2"), true);
        Assert.Equal("stale", stale.State); Assert.Equal("1", stale.Input!.Subject!.Revision);
        await Conflict(() => f.Service.ResolveAsync(f.Owner, row.Id, Resolve()));
    }

    [Fact]
    public async Task AnswerThenCancellationPreservesAnswerAndFencesContinuation()
    {
        using var f = await Fixture.Create(); var row = await f.Service.CreateAsync(f.Source, Input());
        row = await f.Service.ResolveAsync(f.Owner, row.Id, Resolve());
        var answer = CoreJson.Text(row.Resolution!);
        row = await f.Service.WithdrawAsync(f.Source, row.Id, new(Id(), row.Revision, "User cancelled"));
        Assert.Equal(answer, CoreJson.Text(row.Resolution!));
        Assert.Equal("cancelled", row.Continuation!.State);
        row = await f.Service.AckAsync(f.Source, row.Id, new(Id(), row.Resolution!.Revision));
        await Conflict(() => f.Service.ContinueAsync(f.Source, row.Id, new(Id(), Id(), row.Continuation!.Revision, "admitted")));
    }

    [Fact]
    public async Task ContinuationRequiresReceiptAndKeepsOneCommandIdentity()
    {
        using var f = await Fixture.Create(); var row = await f.Service.CreateAsync(f.Source, Input());
        row = await f.Service.ResolveAsync(f.Owner, row.Id, Resolve());
        var command = Id();
        await Conflict(() => f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, 1, "admitted")));
        row = await f.Service.AckAsync(f.Source, row.Id, new(Id(), row.Resolution!.Revision));
        row = await f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "blocked", "unknown_stop"));
        f.Restart();
        await Conflict(() => f.Service.ContinueAsync(f.Source, row.Id, new(Id(), Id(), row.Continuation!.Revision, "admitted")));
        row = await f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "admitted"));
        await Conflict(() => f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "completed")));
        row = await f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "running"));
        row = await f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "completed"));
        await Conflict(() => f.Service.ContinueAsync(f.Source, row.Id, new(Id(), command, row.Continuation!.Revision, "admitted")));
    }

    [Fact]
    public async Task RetentionPreservesWaitsUnresolvedResponsesAndReplayFences()
    {
        using var f = await Fixture.Create(); var pending = await f.Service.CreateAsync(f.Source, Input());
        var unresolved = await f.Service.CreateAsync(f.Source, Input());
        unresolved = await f.Service.ResolveAsync(f.Owner, unresolved.Id, Resolve());
        var create = Input(); var terminal = await f.Service.CreateAsync(f.Source, create);
        terminal = await f.Service.WithdrawAsync(f.Source, terminal.Id, new(Id(), 1, "Not needed"));
        f.Clock.UtcNow = f.Clock.UtcNow.AddDays(31); await f.Store.MaintainAsync(f.Clock.UtcNow); f.Restart();
        Assert.NotNull((await f.Service.GetAsync(f.Owner, pending.Id)).Input);
        Assert.Equal("yes", (await f.Service.GetAsync(f.Owner, unresolved.Id)).Resolution!.Answers["q"].Text);
        var replay = await f.Service.CreateAsync(f.Source, create);
        Assert.Equal(terminal.Id, replay.Id); Assert.Equal("withdrawn", replay.State); Assert.Null(replay.Input);
        await Conflict(() => f.Service.CreateAsync(f.Source, create with { RequestId = Id() }));
    }

    [Fact]
    public async Task QuestionAndOptionIdsDisambiguateRepeatedTextAndRejectForeignAnswers()
    {
        using var f = await Fixture.Create(); var create = Input();
        create = create with { Input = create.Input with { Questions = [
            new("one", "Same question", [new("a", "Same label"), new("b", "Same label")], false),
            new("two", "Same question") ] } };
        var row = await f.Service.CreateAsync(f.Source, create);
        var answers = new Dictionary<string, HostyDecisionAnswer> { ["one"] = new(["b"]), ["two"] = new(Text: "Free text") };
        var accepted = await f.Service.ResolveAsync(f.Owner, row.Id, new(Id(), 1, answers));
        Assert.Equal("b", Assert.Single(accepted.Resolution!.Answers["one"].OptionIds!));
        Assert.Equal("Free text", accepted.Resolution.Answers["two"].Text);
        var invalid = create with { RequestId = Id(), Input = create.Input with { CorrelationKey = Id(), Questions = [new("q", "Choose", [new("a", "A")], false)] } };
        row = await f.Service.CreateAsync(f.Source, invalid);
        var error = await Assert.ThrowsAsync<CoreProviderException>(() => f.Service.ResolveAsync(f.Owner, row.Id, Resolve("Not an option")));
        Assert.Equal(400, error.Status); Assert.Equal("pending", (await f.Service.GetAsync(f.Owner, row.Id)).State);
    }

    [Fact]
    public async Task PaginationUsesStableOrderAndCurrentAuthorizationForEveryPage()
    {
        using var f = await Fixture.Create();
        var first = await f.Service.CreateAsync(f.Source, Input());
        var second = await f.Service.CreateAsync(f.Source, Input());
        var page = await f.Service.QueryAsync(f.Owner, new(Limit: 1, State: "pending"));
        Assert.Equal(first.Id, Assert.Single(page.Items).Id); Assert.NotNull(page.Cursor);
        Assert.Equal(second.Id, Assert.Single((await f.Service.QueryAsync(f.Owner, new(page.Cursor, 1, "pending"))).Items).Id);
        await Assert.ThrowsAsync<CoreProviderException>(() => f.Service.QueryAsync(f.Owner, new(page.Cursor, 1, "history")));
        await f.Users.UpdateAsync(state => state with { Assignments = [] });
        Assert.Empty((await f.Service.QueryAsync(f.Owner, new(page.Cursor, 1, "pending"))).Items);
    }

    [Fact]
    public async Task ExplicitSourceDeletionErasesContentAndHistoricalReplayWithoutRecreatingWork()
    {
        using var f = await Fixture.Create(); var create = Input();
        var original = await f.Service.CreateAsync(f.Source, create);
        var answer = Resolve("private answer");
        var row = await f.Service.ResolveAsync(f.Owner, original.Id, answer);
        var deletion = new HostyDecisionWithdraw(Id(), row.Revision, "Origin deleted", RemoveContent: true);
        var removed = await f.Service.WithdrawAsync(f.Source, row.Id, deletion);
        Assert.Equal("withdrawn", removed.State); Assert.Null(removed.Input); Assert.NotNull(removed.ContentRemovedAt);
        Assert.Empty(removed.Resolution!.Answers); Assert.Null(removed.Delivery);
        f.Restart();
        Assert.Null((await f.Service.CreateAsync(f.Source, create)).Input);
        Assert.Empty((await f.Service.ResolveAsync(f.Owner, row.Id, answer)).Resolution!.Answers);
        Assert.Empty((await f.Service.QueryAsync(f.Source, new(), responses: true)).Items);
        await Conflict(() => f.Service.CreateAsync(f.Source, create with { RequestId = Id() }));
    }

    [Fact]
    public async Task NotificationFailureRetainsQuestionAndReplayRetriesOneDeduplicatedNotice()
    {
        using var f = await Fixture.Create();
        var path = Path.Combine(f.Paths.CoreRoot, "notifications", "notifications.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "invalid JSON");
        var command = Input(); var row = await f.Service.CreateAsync(f.Source, command);
        Assert.True(row.NotificationPending);
        Assert.Equal("pending", (await f.Service.GetAsync(f.Owner, row.Id)).State);
        File.Delete(path); f.Restart();
        var recovered = await f.Service.CreateAsync(f.Source, command);
        Assert.False(recovered.NotificationPending); Assert.Equal(row.Id, recovered.Id);
        await f.Service.CreateAsync(f.Source, command);
        Assert.Single((await new NotificationStore(f.Paths).ReadAsync()).Notifications);
    }

    private static string Id() => Guid.NewGuid().ToString("D");
    private static HostyDecisionCreate Input() => new(Id(), new(Id(), "Choose an approach", [new("q", "Which approach?")], Subject: new("conversation", "source:conversation:1", "1")));
    private static Dictionary<string, HostyDecisionAnswer> Answers(string text) => new() { ["q"] = new(Text: text) };
    private static HostyDecisionResolve Resolve(string text = "yes") => new(Id(), 1, Answers(text));
    private static async Task Conflict(Func<Task<HostyDecisionRecord>> run) => Assert.Equal(409, (await Assert.ThrowsAsync<CoreProviderException>(run)).Status);
    private static async Task Missing(Func<Task<HostyDecisionRecord>> run) => Assert.Equal(404, (await Assert.ThrowsAsync<CoreProviderException>(run)).Status);

    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-11-03T10:00:00Z"); }
    private sealed class Fixture : IDisposable
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-decisions-" + Id());
        internal Clock Clock { get; } = new();
        internal CoreDataPaths Paths { get; }
        internal UserDirectoryStore Users { get; }
        internal AppRegistryStore Registry { get; }
        internal CoreDecisionStore Store { get; private set; } = null!;
        internal CoreDecisionService Service { get; private set; } = null!;
        internal CoreCapabilityCaller Owner { get; }
        internal CoreCapabilityCaller Other { get; }
        internal CoreCapabilityCaller Source => Owner with { App = App, OperatorSession = false };
        internal AppRecord App { get; }
        private Fixture()
        {
            Paths = new(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"), Path.Combine(root, "sources"), Path.Combine(root, "auth"), Path.Combine(root, "audit.ndjson"));
            Users = new(Paths); Registry = new(Paths);
            Owner = new(new("alice", "alice@example.test", "Alice", "host.user", false, Clock.UtcNow, Clock.UtcNow), "user:alice", null, null, true);
            Other = new(new("bob", "bob@example.test", "Bob", "host.admin", false, Clock.UtcNow, Clock.UtcNow), "user:bob", null, null, true);
            App = new("independent.questions", "Independent Questions", null, "1.0.0", "app", false, "local", null, null, null, "idle", "stopped", null, null,
                [], new Dictionary<string, AppSettingValue>(), [], [], [], Clock.UtcNow, Clock.UtcNow,
                GrantedCorePermissions: [CoreAppPermissions.DecisionsRequest, CoreAppPermissions.DecisionsRead, CoreAppPermissions.DecisionsRespond]);
            Restart();
        }
        internal void Restart()
        {
            Store = new(Paths); var events = new CoreEventHub();
            Service = new(Store, Users, Registry, Clock, events, new(new(Paths), Users, events, Clock), NullLogger<CoreDecisionService>.Instance);
        }
        internal static async Task<Fixture> Create(bool registerApp = true)
        {
            var f = new Fixture();
            await f.Users.WriteAsync(new(1, [f.Owner.User, f.Other.User], [], [new(f.App.Id, f.Owner.User.Id, f.Clock.UtcNow)], []));
            if (registerApp) await f.Registry.UpsertAppAsync(f.App);
            return f;
        }
        public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
