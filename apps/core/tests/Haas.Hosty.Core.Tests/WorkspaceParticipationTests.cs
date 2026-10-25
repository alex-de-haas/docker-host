using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceParticipation_OutcomeOrderingAndHeartbeatDoNotReleaseUnconfirmedExecution()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var lease = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await service.SessionActivityAsync(owner, new("running", lease, Sequence: 1), default);
        var changed = (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single().ChangedAt;
        await service.SessionActivityAsync(owner, new("running", lease, Sequence: 2), default);
        Assert.Equal(changed, (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single().ChangedAt);
        await service.SessionActivityAsync(owner, new("failed", Sequence: 3), default);
        var unconfirmed = (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single();
        Assert.Equal("unknown", unconfirmed.Status);
        Assert.Equal(lease, unconfirmed.LeaseId);
        Assert.Contains(lease, (await service.Read(tree.Id, owner, default)).Leases);
        await service.SessionActivityAsync(owner, new("failed", lease, Stopped: true, Sequence: 4), default);
        var failed = (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single();
        Assert.Equal("failed", failed.Status); Assert.Null(failed.LeaseId);
        Assert.Empty((await service.Read(tree.Id, owner, default)).Leases);
        await service.SessionActivityAsync(owner, new("running", lease, Sequence: 2), default);
        Assert.Equal("failed", (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single().Status);
        var next = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: next), default);
        await service.SessionActivityAsync(owner, new("running", next, Sequence: 5), default);
        await service.SessionActivityAsync(owner, new("failed", lease, Stopped: true, Sequence: 4), default);
        Assert.Equal("running", (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single().Status);
        Assert.Contains(next, (await service.Read(tree.Id, owner, default)).Leases);
        await service.SessionActivityAsync(owner, new("idle", next, Stopped: true, Sequence: 6), default);
        Assert.Equal("idle", (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single().Status);
    }

    [Fact]
    public async Task WorkspaceParticipation_MigrationPreservesSourceAndIndependentIdentity()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "unfinished work");
        var participation = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        Assert.Equal(tree.WorkspaceId, participation.Id);
        Assert.Equal(owner, participation.AllocationOwner);
        Assert.Equal(owner, Assert.Single(participation.Sessions).Session);
        Assert.Equal("owner", Assert.Single(participation.Members).Role);
        var restart = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var recovered = await restart.ReadParticipationAsync(tree.WorkspaceId, default);
        Assert.Equal(CoreJson.Text(participation), CoreJson.Text(recovered));
        var retained = await restart.Read(tree.Id, owner, default);
        Assert.Equal(tree.Path, retained.Path);
        Assert.Equal(tree.Branch, retained.Branch);
        Assert.Equal(tree.OriginalBase, retained.OriginalBase);
        Assert.Equal(tree.Operations, retained.Operations);
        Assert.Equal("unfinished work", await File.ReadAllTextAsync(Path.Combine(tree.Path, "README.md")));
    }

    [Fact]
    public async Task WorkspaceParticipation_DetachCreatorLeavesWorkspaceAndAnotherUsersSession()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var colleague = owner with { UserId = "colleague", SessionId = "review-session" };
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant",
            new(Guid.NewGuid().ToString(), state.Revision, colleague.UserId, [tree.Id]), default);
        state = await service.ChangeSessionAsync(state.Id, colleague, "attach",
            new(Guid.NewGuid().ToString(), state.Revision, "Review", "/chat/review-session"), default);
        state = await service.ChangeSessionAsync(state.Id, owner, "detach",
            new(Guid.NewGuid().ToString(), state.Revision), default);
        Assert.Null(await service.SessionParticipationAsync(owner, default));
        Assert.Equal(state.Id, (await service.SessionParticipationAsync(colleague, default))!.Id);
        Assert.Equal(owner.UserId, Assert.Single(state.Members, m => m.Role == "owner").UserId);
        Assert.True(Directory.Exists(tree.Path));
        Assert.Equal(tree.OriginalBase, (await RunGitAsync(tree.Path, ["rev-parse", "HEAD"])).Trim());
        await service.ChangeWorkflowAsync(owner, owner.UserId, "defer", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        Assert.Equal("closed", (await service.SessionWorkflowAsync(colleague, default)).Closure);
        Assert.Equal(new WorkspaceWorkflow(), await service.SessionWorkflowAsync(owner, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.Read(tree.Id, owner, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, WorkspaceRequest(), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.SessionResourceOwnerAsync(owner, default, ownerOnly: true));
    }

    [Fact]
    public async Task WorkspaceParticipation_ReplayDoesNotUndoLaterDetachOrRevocation()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var colleague = owner with { UserId = "colleague", SessionId = "review" };
        var grant = new WorkspaceMemberCommand(Guid.NewGuid().ToString(), state.Revision, colleague.UserId, [tree.Id]);
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant, default);
        var attach = new WorkspaceSessionCommand(Guid.NewGuid().ToString(), state.Revision, "Review", "/review");
        state = await service.ChangeSessionAsync(state.Id, colleague, "attach", attach, default);
        state = await service.ChangeSessionAsync(state.Id, colleague, "detach", new(Guid.NewGuid().ToString(), state.Revision), default);
        state = await service.ChangeSessionAsync(state.Id, colleague, "attach", attach, default);
        Assert.NotNull(state.Sessions.Single(s => s.Session == colleague).DetachedAt);
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "revoke", new(Guid.NewGuid().ToString(), state.Revision, colleague.UserId), default);
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant, default);
        Assert.NotNull(state.Members.Single(m => m.UserId == colleague.UserId).RevokedAt);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeSessionAsync(state.Id, colleague, "attach", attach, default));
        var conflicting = await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant with { WorktreeIds = [] }, default));
        Assert.Equal("workspace_request_conflict", conflicting.Code);
    }

    [Fact]
    public async Task WorkspaceParticipation_ConcurrentAttachHasOneWinnerAndCannotBindTwoWorkspaces()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var secondOwner = owner with { SessionId = "second" };
        var second = await service.PrepareAsync(secondOwner, WorkspaceRequest("second"), default);
        var a = await service.ParticipationAsync(first.WorkspaceId, owner.UserId, default);
        var b = await service.ParticipationAsync(second.WorkspaceId, owner.UserId, default);
        var session = owner with { SessionId = "unbound" };
        async Task<bool> Attach(WorkspaceParticipation target)
        {
            try
            {
                await service.ChangeSessionAsync(target.Id, session, "attach", new(Guid.NewGuid().ToString(), target.Revision, "Parallel", "/chat/unbound"), default);
                return true;
            }
            catch (AppLifecycleException ex) when (ex.Code == "workspace_session_bound") { return false; }
        }
        var results = await Task.WhenAll(Attach(a), Attach(b));
        Assert.Single(results, success => success);
        Assert.NotNull(await service.SessionParticipationAsync(session, default));
        Assert.Equal(2, (await service.ListAsync(null, true, default)).Workspaces.Length);
    }

    [Fact]
    public async Task WorkspaceParticipation_GrantRequiresOwnerExactRevisionAndContainedRepositories()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var grant = new WorkspaceMemberCommand(Guid.NewGuid().ToString(), state.Revision, "colleague", [tree.Id]);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, "outsider", "grant", grant, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant with { ExpectedRevision = 0 }, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant with { WorktreeIds = [new string('a', 64)] }, default));
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", grant, default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, "colleague", "grant", new(Guid.NewGuid().ToString(), state.Revision, "outsider", [tree.Id]), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeMemberAsync(state.Id, owner.UserId, "revoke", new(Guid.NewGuid().ToString(), state.Revision, owner.UserId), default));
    }

    [Fact]
    public async Task WorkspaceParticipation_UnknownActivityPreventsDetachAndRevocationKeepsEvidence()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var lease = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var blocked = await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeSessionAsync(state.Id, owner, "detach", new(Guid.NewGuid().ToString(), state.Revision), default));
        Assert.Equal("workspace_session_busy", blocked.Code);
        Assert.Contains(lease, (await service.Read(tree.Id, owner, default)).Leases);
        Assert.NotNull(await service.SessionParticipationAsync(owner, default));
    }
    [Fact]
    public async Task WorkspaceParticipation_AttachedPrepareReusesSourceAndRevocationFencesReads()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var other = owner with { UserId = "colleague", SessionId = "parallel" };
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", new(Guid.NewGuid().ToString(), state.Revision, other.UserId, [tree.Id]), default);
        state = await service.ChangeSessionAsync(state.Id, other, "attach", new(Guid.NewGuid().ToString(), state.Revision, "Parallel", "/chat/parallel"), default);
        var prepared = await service.PrepareAsync(other, WorkspaceRequest("parallel"), default);
        Assert.Equal(tree.Id, prepared.Id);
        Assert.Equal(tree.Path, prepared.Path);
        Assert.Single((await service.ListAsync(null, true, default)).Workspaces);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "shared edit");
        Assert.Contains("shared edit", (await service.DiffAsync(tree.Id, other, new("README.md"), default)).Combined);
        await service.ChangeMemberAsync(state.Id, owner.UserId, "revoke", new(Guid.NewGuid().ToString(), state.Revision, other.UserId), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.Read(tree.Id, other, default));
        Assert.Empty((await service.ListAsync(other, true, default)).Workspaces);
        Assert.Equal("shared edit", await File.ReadAllTextAsync(Path.Combine(tree.Path, "README.md")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceParticipation_ResourceContextUsesTheGrantedRepository(bool explicitWorkspace)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var repository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "other-repository"));
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other" }, default);
        var trees = (await service.ListAsync(null, true, default)).Workspaces;
        Assert.Equal(2, trees.Length);
        var shared = trees[1]; var unshared = trees[0];
        var member = owner with { UserId = "colleague", SessionId = "partial-source" };
        var participation = await service.ParticipationAsync(first.WorkspaceId, owner.UserId, default);
        participation = await service.ChangeMemberAsync(participation.Id, owner.UserId, "grant",
            new(Guid.NewGuid().ToString(), participation.Revision, member.UserId, [shared.Id]), default);
        await service.ChangeSessionAsync(participation.Id, member, "attach",
            new(Guid.NewGuid().ToString(), participation.Revision, "Partial source", "/chat/partial-source"), default);
        var actor = new SandboxActor(member.UserId, member.AppId, member.Installation);
        var context = new SandboxContext(WorkspaceId: explicitWorkspace ? first.WorkspaceId : null, SessionId: member.SessionId);
        var project = Path.Combine(shared.Path, "Core.csproj"); await File.WriteAllTextAsync(project, "<Project />");
        var environments = new CoreEnvironmentService(new(f.Paths), new SourceGuardRuntime(), f.Clock, service);
        var child = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Partial source", "source", project, context, [shared.Id]), default);
        Assert.Equal("stopped", child.State);
        var denied = await Assert.ThrowsAsync<SandboxException>(() => environments.CreateAsync(actor,
            new(Guid.NewGuid().ToString(), "Unshared source", "source", project, context, [unshared.Id]), default));
        Assert.Equal("environment_worktree_forbidden", denied.Code);
        var wrongContext = await Assert.ThrowsAsync<AppLifecycleException>(() => environments.CreateAsync(actor,
            new(Guid.NewGuid().ToString(), "Missing workspace", Context: context with { WorkspaceId = new string('f', 64) }), default));
        Assert.Equal("workspace_not_found", wrongContext.Code);
        var sandboxes = new SandboxService(new(f.Paths), new ResourceControlInputs(shared.Path), new ResourceControlSandboxRuntime(), f.Clock, workspaces: service);
        var plan = await sandboxes.PlanAsync(actor, new(shared.Apps[0].AppId, "sandbox", new("worktree", shared.Id), Context: context), default);
        var sandbox = await sandboxes.PrepareAsync(actor, new(Guid.NewGuid().ToString(), plan.Id, plan.Digest), default);
        Assert.Equal("prepared", sandbox.State);
    }

    [Fact]
    public async Task WorkspaceParticipation_ParallelLeasesCannotBeReleasedByOtherSessionAndRevokeRetainsStopEvidence()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var other = owner with { UserId = "colleague", SessionId = "parallel" };
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", new(Guid.NewGuid().ToString(), state.Revision, other.UserId, [tree.Id]), default);
        state = await service.ChangeSessionAsync(state.Id, other, "attach", new(Guid.NewGuid().ToString(), state.Revision, "Parallel", "/parallel"), default);
        var firstLease = Guid.NewGuid().ToString(); var secondLease = Guid.NewGuid().ToString();
        await Task.WhenAll(service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: firstLease), default),
            service.CommandAsync(tree.Id, other, "lease", new(Guid.NewGuid().ToString(), LeaseId: secondLease), default));
        Assert.Equal(2, (await service.Read(tree.Id, owner, default)).Leases.Length);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.SessionActivityAsync(owner, new("idle", secondLease, true), default));
        await service.SessionActivityAsync(other, new("running", secondLease), default);
        await service.ChangeMemberAsync(state.Id, owner.UserId, "revoke", new(Guid.NewGuid().ToString(), state.Revision, other.UserId), default);
        Assert.True((await service.SessionActivityAsync(other, new("running", secondLease), default)).StopRequested);
        Assert.Contains(secondLease, (await service.Read(tree.Id, owner, default)).Leases);
        await service.SessionActivityAsync(other, new("idle", secondLease, true), default);
        Assert.Equal([firstLease], (await service.Read(tree.Id, owner, default)).Leases);
        Assert.Equal("idle", (await service.ReadParticipationAsync(tree.WorkspaceId, default))!.Sessions.Single(s => s.Session == other).Status);
    }

    [Fact]
    public async Task WorkspaceParticipation_CommitReviewRejectsChangedSelectionAndPreservesOtherFiles()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var other = owner with { SessionId = "parallel" };
        await service.ChangeSessionAsync(state.Id, other, "attach", new(Guid.NewGuid().ToString(), state.Revision, "Parallel", "/parallel"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "reviewed contents");
        var review = await service.PrepareCommitReviewAsync(tree.Id, owner, new(Guid.NewGuid().ToString(), tree.OriginalBase, ["README.md"]), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "another participant's change");
        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), tree.OriginalBase, "test: selected changes", ["README.md"], "Test", "test@example.test", ReviewId: review.Id);
        var stale = await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(tree.Id, owner, "commit", command, default));
        Assert.Equal("workspace_commit_review_stale", stale.Code);
        Assert.Equal(tree.OriginalBase, (await RunGitAsync(tree.Path, ["rev-parse", "HEAD"])).Trim());
        review = await service.PrepareCommitReviewAsync(tree.Id, owner, new(Guid.NewGuid().ToString(), tree.OriginalBase, ["README.md"]), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unrelated.txt"), "leave uncommitted");
        var committed = await service.CommandAsync(tree.Id, owner, "commit", command with { RequestId = Guid.NewGuid().ToString(), ReviewId = review.Id }, default);
        Assert.NotEqual(tree.OriginalBase, committed.Observation!.Head);
        Assert.Contains("unrelated.txt", (await RunGitAsync(tree.Path, ["status", "--porcelain"])).Trim());
        Assert.Equal("another participant's change", (await RunGitAsync(tree.Path, ["show", "HEAD:README.md"])).Trim());
    }

    [Fact]
    public async Task WorkspaceParticipation_PrivateLocalReadsDoNotRefreshOwnerCredentialsAndRevokeImmediately()
    {
        var (f, _, initial, _) = await DocumentFixtureAsync();
        var owner = WorkspaceTestOwner(f);
        var tree = await initial.PrepareAsync(owner, WorkspaceRequest(), default);
        var (users, access, grant) = await PrivateDocumentAccessAsync(f, tree.Repository);
        await f.Apps.UpdateAppAsync(SourceTestApp, a => a with { PrivateSources = new(Git: grant) });
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree with { SourceGrant = grant });
        // RefreshAsync throws in this provider. A near-expiry OAuth connection must therefore
        // remain readable locally without entering its credential refresh path.
        await users.UpdateAsync(state => state with { ProviderConnections = state.ProviderConnections!.Select(c =>
            c.UserId == owner.UserId ? c with { Method = "oauth", ExpiresAt = f.Clock.UtcNow.AddMinutes(1) } : c).ToArray() });
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: access, participantUsers: users);
        var state = await workspaces.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        state = await workspaces.ChangeMemberAsync(state.Id, owner.UserId, "grant", new(Guid.NewGuid().ToString(), state.Revision, "bob", [tree.Id]), default);
        var member = owner with { UserId = "bob", SessionId = "private-review" };
        await workspaces.ChangeSessionAsync(state.Id, member, "attach", new(Guid.NewGuid().ToString(), state.Revision, "Private review", "/review"), default);
        Assert.Equal(tree.Path, (await workspaces.Read(tree.Id, member, default)).Path);
        var documents = new SourceDocumentService(f.Apps, workspaces, access);
        var entries = await documents.ListWorkspacesAsync("bob", null, default);
        var entry = Assert.Single(entries.Workspaces);
        var listing = await documents.ListDocumentsAsync(entry.RepositoryId, "bob", false, default, "worktree", tree.Id);
        Assert.NotEmpty(listing.Documents);
        await users.UpdateAsync(value => value with { ProviderConnections = value.ProviderConnections!.Where(c => c.UserId != owner.UserId).ToArray() });
        await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.Read(tree.Id, member, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.RepositoryId, "bob", false, default, "worktree", tree.Id));
    }
}
