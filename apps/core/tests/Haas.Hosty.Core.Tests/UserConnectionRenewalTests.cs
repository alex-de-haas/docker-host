using System.Net;
using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class UserConnectionTests
{
    [Theory]
    [InlineData(false, "public_repo")]
    [InlineData(true, "repo")]
    public async Task GitHubAuthorizationRequestsWorkflowAndReportsOnlyBoundedGrantedScopes(bool privateRepositories, string repositoryScope)
    {
        using var f = await Fixture.Create();
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: privateRepositories), Ct);
        var form = Uri.UnescapeDataString(f.Http.Calls[0].Body.Replace("+", " "));
        Assert.Contains($"scope={repositoryScope} workflow user:email offline_access", form);
        f.Http.Json("""{"access_token":"device-secret","refresh_token":"refresh-secret","scope":"workflow, repo repo,user:email","expires_in":3600}""");
        f.Http.Json(IdentityJson); f.Clock.Advance(5);
        var done = await f.Service.PollAsync("alice", attempt.Id, Ct);
        Assert.Equal(new[] { "repo", "user:email", "workflow" }, done.Connection!.GrantedScopes);
        Assert.Equal(done.Connection.GrantedScopes, Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).GrantedScopes);
        var response = CoreJson.Text(done);
        Assert.DoesNotContain("device-secret", response); Assert.DoesNotContain("refresh-secret", response);
    }

    [Theory]
    [InlineData("42")]
    [InlineData("\"repo,invalid\\nscope\"")]
    [InlineData("\"repo,invalid/scope\"")]
    public async Task GitHubInvalidPermissionMetadataIsRejectedWithoutExposingIt(string scope)
    {
        using var f = await Fixture.Create();
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct);
        f.Http.Json("{\"access_token\":\"secret\",\"scope\":" + scope + "}"); f.Clock.Advance(5);
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempt.Id, Ct));
        Assert.Equal("provider_response_invalid", error.Code);
        Assert.DoesNotContain(scope, error.Message); Assert.Empty((await f.Users.ReadAsync()).ProviderConnections ?? []);
    }

    [Fact]
    public async Task OAuthRenewalPreservesConnectionIdentityAndExistingSourceGrant()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var summary = await f.Service.AddPatAsync("alice", new("Saved label", "github", Token: "old-secret"), Ct);
        var before = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        var sources = new PrivateSourceService(f.Service, f.Client);
        var grant = await sources.BindAsync("alice", summary.Id, "https://github.com/owner/repository.git", false, Ct);
        var originalGrant = CoreJson.Text(grant);
        f.Clock.Advance(30); f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new("Ignored replacement label", "github", PrivateRepositories: false), Ct, summary.Id);
        Assert.Equal("old-secret", await sources.WithConnectionAsync(grant, c => Task.FromResult(c.AccessToken), Ct));
        f.Http.Json("""{"access_token":"renewed-secret","refresh_token":"renewed-refresh","scope":"public_repo,workflow,user:email","expires_in":3600}""");
        f.Http.Json("""{"id":42,"login":"renamed-login"}"""); f.Clock.Advance(5);
        var done = await f.Service.PollAsync("alice", attempt.Id, Ct);
        var after = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        Assert.Equal(before.Id, after.Id); Assert.Equal(before.Provider, after.Provider); Assert.Equal(before.AccountId, after.AccountId);
        Assert.Equal(before.Label, after.Label); Assert.Equal(before.CreatedAt, after.CreatedAt); Assert.NotEqual(before.Revision, after.Revision);
        Assert.Equal("renamed-login", after.AccountName); Assert.Equal("oauth", after.Method);
        Assert.Equal(summary.Id, done.Connection!.Id);
        Assert.Equal("renewed-secret", await sources.WithConnectionAsync(grant, c => Task.FromResult(c.AccessToken), Ct));
        Assert.Equal(originalGrant, CoreJson.Text(grant));
        Assert.DoesNotContain("renewed-secret", CoreJson.Text(done));
        Assert.DoesNotContain("renewed-secret", await File.ReadAllTextAsync(f.Paths.AuditLogPath));
        Assert.Contains("auth.connection.renewed", await File.ReadAllTextAsync(f.Paths.AuditLogPath));
    }

    [Fact]
    public async Task PatRenewalRetainsReferencesAndClearsPreviousOAuthCredentialMetadata()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var summary = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "original-secret"), Ct);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with {
            Method = "oauth", RefreshToken = "previous-refresh", ClientId = "previous-client", ExpiresAt = f.Clock.UtcNow.AddHours(1),
            GrantedScopes = ["repo", "workflow"] }).ToArray() });
        var before = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        f.Http.Json(IdentityJson); f.Clock.Advance(10);
        var result = await f.Service.AddPatAsync("alice", new("Ignored", "github", Token: " replacement-secret "), Ct, summary.Id);
        var after = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        Assert.Equal(before.Id, after.Id); Assert.Equal(before.Label, after.Label); Assert.Equal(before.CreatedAt, after.CreatedAt);
        Assert.Equal("pat", after.Method); Assert.Equal("replacement-secret", after.AccessToken);
        Assert.Null(after.RefreshToken); Assert.Null(after.ClientId); Assert.Null(after.ExpiresAt); Assert.Null(after.GrantedScopes);
        Assert.Equal(before.Id, result.Id); Assert.DoesNotContain("replacement-secret", CoreJson.Text(result));
    }

    [Theory]
    [InlineData("cancel")]
    [InlineData("expire")]
    [InlineData("decline")]
    [InlineData("account")]
    [InlineData("identity-unavailable")]
    public async Task IncompleteOAuthRenewalPreservesThePreviousCredential(string outcome)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        var before = CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!));
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: false), Ct, connection.Id);
        if (outcome == "cancel") await f.Service.CancelAsync("alice", attempt.Id, Ct);
        else if (outcome == "expire") f.Clock.Advance(901);
        else
        {
            if (outcome == "decline") f.Http.Json("""{"error":"access_denied"}""", HttpStatusCode.BadRequest);
            else
            {
                f.Http.Json("""{"access_token":"unaccepted-secret"}""");
                f.Http.Json(outcome == "account" ? """{"id":43,"login":"other-account"}""" : "provider failure",
                    outcome == "account" ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
            }
            f.Clock.Advance(5);
        }
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempt.Id, Ct));
        Assert.Equal(before, CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!)));
        Assert.DoesNotContain("auth.connection.renewed", await File.ReadAllTextAsync(f.Paths.AuditLogPath));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PatRenewalRejectsAnotherAccountOrProviderWithoutReplacingTheConnection(bool differentProvider)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        if (differentProvider)
            await f.Users.UpdateAsync(s => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with { Provider = "legacy-provider" }).ToArray() });
        else f.Http.Json("""{"id":43,"login":"other-account"}""");
        var before = CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!));
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.AddPatAsync("alice", new(null, "github", Token: "unaccepted-secret"), Ct, connection.Id));
        Assert.Equal(differentProvider ? "connection_provider_mismatch" : "provider_account_changed", error.Code);
        Assert.Equal(before, CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!)));
    }

    [Fact]
    public async Task RenewalDoesNotRevealOrMutateAnotherOwnersConnection()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        var now = f.Clock.UtcNow;
        await f.Users.UpdateAsync(s => s with { Sessions = [.. s.Sessions, new("bob-browser", "bob", now, now.AddHours(1), null, now)] });
        var pat = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.AddPatAsync("bob", new(null, "github", Token: "secret"), Ct, connection.Id));
        var oauth = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.StartDeviceAsync("bob", "bob-browser", new(null, "github", PrivateRepositories: false), Ct, connection.Id));
        Assert.Equal("connection_not_found", pat.Code); Assert.Equal("connection_not_found", oauth.Code);
        Assert.Single(f.Http.Calls); Assert.Equal("retained-secret", Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).AccessToken);
    }

    [Fact]
    public async Task CompetingRenewalsAreRejectedUntilTheOwnerCancelsTheOriginalAttempt()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: false), Ct, connection.Id);
        Assert.Equal("connection_attempt_pending", (await Assert.ThrowsAsync<UserConnectionException>(() =>
            f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: false), Ct, connection.Id))).Code);
        Assert.Equal("connection_attempt_pending", (await Assert.ThrowsAsync<UserConnectionException>(() =>
            f.Service.AddPatAsync("alice", new(null, "github", Token: "not-yet-used"), Ct, connection.Id))).Code);
        Assert.Equal(2, f.Http.Calls.Count);
        await f.Service.CancelAsync("alice", attempt.Id, Ct);
        f.Http.Json(IdentityJson);
        Assert.Equal(connection.Id, (await f.Service.AddPatAsync("alice", new(null, "github", Token: "replacement"), Ct, connection.Id)).Id);
    }

    [Theory]
    [InlineData("rename")]
    [InlineData("check")]
    [InlineData("disconnect")]
    public async Task OAuthRenewalCannotOverwriteAChangedOrDisconnectedConnection(string change)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: false), Ct, connection.Id);
        if (change == "rename") await f.Service.RenameAsync("alice", connection.Id, "New label", Ct);
        else if (change == "check") { f.Http.Json(IdentityJson); await f.Service.CheckAsync("alice", connection.Id, Ct); }
        else await f.Service.DisconnectAsync("alice", connection.Id, Ct);
        f.Clock.Advance(5);
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempt.Id, Ct));
        Assert.Equal(change == "disconnect" ? "connection_attempt_missing" : "connection_changed", error.Code);
        var stored = (await f.Users.ReadAsync()).ProviderConnections ?? [];
        if (change == "disconnect") Assert.Empty(stored);
        else Assert.Equal("retained-secret", Assert.Single(stored).AccessToken);
        Assert.Equal(change == "check" ? 3 : 2, f.Http.Calls.Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AtomicRenewalCannotResurrectOrOverwriteAConcurrentCredentialChange(bool remove)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Http.Enqueue(async _ => { entered.SetResult(); await released.Task; return Reply(IdentityJson); });
        var renewing = f.Service.AddPatAsync("alice", new(null, "github", Token: "stale-replacement"), Ct, connection.Id);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await f.Users.UpdateAsync(s => s with { ProviderConnections = remove ? [] : s.ProviderConnections!.Select(c =>
                c with { AccessToken = "newer-secret", Revision = "newer-revision" }).ToArray() });
        }
        finally { released.SetResult(); }
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => renewing);
        Assert.Equal(remove ? "connection_not_found" : "connection_changed", error.Code);
        var stored = (await f.Users.ReadAsync()).ProviderConnections ?? [];
        if (remove) Assert.Empty(stored); else Assert.Equal("newer-secret", Assert.Single(stored).AccessToken);
    }

    [Fact]
    public async Task KnownPrivateRepositoryScopeAndOAuthRegistrationSurviveExplicitRenewal()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "old-secret"), Ct);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with {
            Method = "oauth", ClientId = "original-client", GrantedScopes = ["repo", "user:email"] }).ToArray() });
        f.Config["ProviderConnections:GitHubClientId"] = "different-client";
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct, connection.Id);
        var form = Uri.UnescapeDataString(f.Http.Calls.Last().Body.Replace("+", " "));
        Assert.Contains("scope=repo workflow user:email offline_access", form); Assert.Contains("client_id=original-client", form);
        await f.Service.CancelAsync("alice", attempt.Id, Ct);
    }

    [Fact]
    public async Task LegacyRenewalRequiresAnExplicitRepositoryAccessDecisionBeforeStartingAuthorization()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "old-secret"), Ct);
        var error = await Assert.ThrowsAsync<UserConnectionException>(() =>
            f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct, connection.Id));
        Assert.Equal("connection_scope_decision_required", error.Code); Assert.Single(f.Http.Calls);
        Assert.Equal("old-secret", Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).AccessToken);
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: true), Ct, connection.Id);
        Assert.Equal("pending", attempt.Status);
        await f.Service.CancelAsync("alice", attempt.Id, Ct);
    }

    [Theory]
    [InlineData("repo,workflow", "public_repo,workflow", false)]
    [InlineData("repo,workflow", "repo", false)]
    [InlineData("public_repo,workflow", "workflow", false)]
    [InlineData(null, "", false)]
    [InlineData(null, "public_repo,workflow", true)]
    public async Task ExplicitlyInsufficientRenewalScopesCannotReplaceThePreviousCredential(string? previousScopes, string grantedScopes, bool requestPrivate)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with {
            Method = "oauth", ClientId = "original-client", GrantedScopes = previousScopes?.Split(',') }).ToArray() });
        var before = CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!));
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github", PrivateRepositories: requestPrivate), Ct, connection.Id);
        f.Http.Json(JsonSerializer.Serialize(new { access_token = "insufficient-secret", scope = grantedScopes }));
        f.Http.Json(IdentityJson); f.Clock.Advance(5);
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempt.Id, Ct));
        Assert.Equal("connection_scope_insufficient", error.Code);
        Assert.Equal(before, CoreJson.Text(Assert.Single((await f.Users.ReadAsync()).ProviderConnections!)));
        Assert.DoesNotContain("insufficient-secret", error.Message);
        Assert.DoesNotContain("auth.connection.renewed", await File.ReadAllTextAsync(f.Paths.AuditLogPath));
    }

    [Fact]
    public async Task RenewalWithoutScopeEvidenceRetainsTheConnectionWithUnknownGrantedScopes()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new("Saved", "github", Token: "retained-secret"), Ct);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with {
            Method = "oauth", ClientId = "original-client", GrantedScopes = new[] { "repo", "workflow" } }).ToArray() });
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct, connection.Id);
        f.Http.Json("""{"access_token":"renewed-secret","refresh_token":"renewed-refresh","expires_in":3600}""");
        f.Http.Json(IdentityJson); f.Clock.Advance(5);
        var result = await f.Service.PollAsync("alice", attempt.Id, Ct);
        var stored = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        Assert.Equal(connection.Id, stored.Id); Assert.Equal("renewed-secret", stored.AccessToken);
        Assert.Null(stored.GrantedScopes); Assert.Null(result.Connection!.GrantedScopes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefreshPreservesGrantedScopesUnlessTheProviderSuppliesNewEvidence(bool explicitScopes)
    {
        using var f = await Fixture.Create(); f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct);
        f.Http.Json("""{"access_token":"old-token","refresh_token":"old-refresh","expires_in":1,"scope":"repo,workflow"}""");
        f.Http.Json(IdentityJson); f.Clock.Advance(5);
        var connection = (await f.Service.PollAsync("alice", attempt.Id, Ct)).Connection!;
        f.Http.Json(explicitScopes ? """{"access_token":"refreshed","expires_in":3600,"scope":"public_repo"}""" : """{"access_token":"refreshed","expires_in":3600}""");
        f.Http.Json(IdentityJson);
        var checkedConnection = await f.Service.CheckAsync("alice", connection.Id, Ct);
        Assert.Equal(explicitScopes ? new[] { "public_repo" } : ["repo", "workflow"], checkedConnection.GrantedScopes);
        Assert.Equal(checkedConnection.GrantedScopes, Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).GrantedScopes);
    }
}
