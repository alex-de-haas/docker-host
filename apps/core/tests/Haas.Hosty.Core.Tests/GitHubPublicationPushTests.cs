using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    [Theory]
    [InlineData("refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope", "push_workflow_permission_required")]
    [InlineData("refusing to allow a Personal Access Token to create or update workflow without workflow scope", "push_workflow_permission_required")]
    [InlineData("refusing to allow a GitHub App to create or update workflow without workflows permission", "push_workflow_permission_required")]
    [InlineData("fatal: Authentication failed for 'https://github.com/owner/repo.git'", "push_authentication_failed")]
    [InlineData("remote: Invalid username or token. Password authentication is not supported for Git operations.", "push_authentication_failed")]
    [InlineData("remote: Write access to repository not granted.", "push_access_denied")]
    [InlineData("fatal: repository 'https://github.com/owner/repo.git/' not found", "push_access_denied")]
    [InlineData("remote: Repository not found.", "push_access_denied")]
    [InlineData("remote: Permission to owner/repo.git denied to example.", "push_access_denied")]
    [InlineData("remote: error: GH006: Protected branch update failed for refs/heads/feature.", "push_protected_branch")]
    [InlineData("remote: error: GH013: Repository rule violations found for refs/heads/feature.", "push_protected_branch")]
    public void PushFailureReportsKnownActionableReasonWithoutEchoingProviderOutput(string stderr, string code)
    {
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("x-access-token:" + Connection.AccessToken));
        var untrusted = stderr + "\nAuthorization: Basic " + basic + "\nBearer " + Connection.AccessToken +
            "\nhttps://user:other-secret@github.com/owner/repo?access_token=more-secret\n\u001b[31mmalicious terminal text";
        var error = Assert.Throws<PublicationException>(() => GitHubPublicationProvider.RequirePushSuccess(new(128, "", untrusted, false), "feature"));
        Assert.Equal("publication_" + code, error.Code);
        Assert.True(error.SafeDiagnostic);
        Assert.DoesNotContain(Connection.AccessToken, error.Message);
        Assert.DoesNotContain(basic, error.Message);
        Assert.DoesNotContain("other-secret", error.Message);
        Assert.DoesNotContain("more-secret", error.Message);
        Assert.DoesNotContain("malicious", error.Message);
        Assert.True(error.Message.Length < 600);
    }

    [Theory]
    [InlineData("[rejected] (non-fast-forward)", "push_non_fast_forward")]
    [InlineData("[rejected] (fetch first)", "push_non_fast_forward")]
    [InlineData("[remote rejected] (protected branch hook declined)", "push_protected_branch")]
    [InlineData("[remote rejected] (pre-receive hook declined)", "push_rejected")]
    public void PushPorcelainDistinguishesDefiniteRefRejection(string status, string code)
    {
        var output = "To https://github.com/owner/repo.git\n!\thead:refs/heads/feature\t" + status + "\nDone\n";
        var error = Assert.Throws<PublicationException>(() => GitHubPublicationProvider.RequirePushSuccess(new(1, output, "", false), "feature"));
        Assert.Equal("publication_" + code, error.Code);
        Assert.Contains("original request ID", error.Message);
    }

    [Theory]
    [InlineData("fatal: Could not resolve host: github.com", "resolve")]
    [InlineData("fatal: Failed to connect to github.com port 443", "connect")]
    [InlineData("fatal: SSL certificate problem: unknown CA", "TLS")]
    [InlineData("error: RPC failed; curl 56 unexpected disconnect", "transport")]
    [InlineData("unrecognized output containing provider-secret", "code 128")]
    public void PushTransportAndUnknownFailureRetainUncertaintyWithSafeDiagnostic(string stderr, string expected)
    {
        var error = Assert.Throws<PublicationException>(() => GitHubPublicationProvider.RequirePushSuccess(new(128, "", stderr + new string('x', 300_000), false), "feature"));
        Assert.Equal("publication_push_uncertain", error.Code);
        Assert.Contains(expected, error.Message);
        Assert.Contains("original request ID", error.Message);
        Assert.DoesNotContain("provider-secret", error.Message);
        Assert.True(error.Message.Length < 600);
    }

    [Fact]
    public void PushTimeoutAndUnrelatedRefStatusNeverProveRejection()
    {
        var timeout = Assert.Throws<PublicationException>(() => GitHubPublicationProvider.RequirePushSuccess(new(-1,
            "!\thead:refs/heads/feature\t[remote rejected]", "refusing to allow an OAuth App to create or update workflow without workflow scope", true), "feature"));
        Assert.Equal("publication_push_uncertain", timeout.Code);
        Assert.Contains("timed out", timeout.Message);
        var unrelated = Assert.Throws<PublicationException>(() => GitHubPublicationProvider.RequirePushSuccess(new(1,
            "!\thead:refs/heads/other\t[remote rejected]", "", false), "feature"));
        Assert.Equal("publication_push_uncertain", unrelated.Code);
        GitHubPublicationProvider.RequirePushSuccess(new(0, "", "", false), "feature");
    }
}

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task Publication_PendingPushRetainsSafeDiagnosticAndRecoversAfterSameConnectionRenewal()
    {
        var f = await PublicationFixture();
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Workflow publication");
        f.Provider.PushFailure = "uncertain";
        var pendingError = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default));
        Assert.Equal("publication_push_uncertain", pendingError.Code);
        var pending = Assert.Single((await f.Service.ListAsync(f.W.Owner, default)).Publications);
        Assert.Equal("pending", Assert.Single(pending.Operations).State);
        Assert.Equal(pendingError.Code, pending.Operations[0].ErrorCode);
        Assert.Equal(pendingError.Message, pending.Operations[0].Error);
        Assert.Equal(0, f.Provider.Created);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input with { RequestId = Guid.NewGuid().ToString() }, default));

        // Recovery of a legacy uncertain request can reveal a definite provider rejection.
        f.Provider.PushFailure = "workflow";
        var rejected = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default));
        Assert.Equal("publication_push_workflow_permission_required", rejected.Code);
        var failed = Assert.Single((await f.Service.ListAsync(f.W.Owner, default)).Publications);
        Assert.Equal("failed", Assert.Single(failed.Operations).State);
        Assert.Equal(rejected.Code, failed.Operations[0].ErrorCode);
        Assert.Equal(rejected.Message, failed.Operations[0].Error);
        Assert.Equal(0, f.Provider.Created);
        Assert.Equal(input.ExpectedHead, (await f.Workspaces.ObserveAsync(f.W.Id, f.W.Owner, default)).Observation!.Head);

        // Credential replacement under the same connection ID leaves the publication binding intact.
        await f.Users.UpdateAsync(state => state with { ProviderConnections = state.ProviderConnections!.Select(c =>
            c.Id == "connection" ? c with { AccessToken = "renewed-fixture-secret", Revision = "renewed" } : c).ToArray() });
        f.Provider.BeforePush = c => { Assert.Equal("connection", c.Id); Assert.Equal("renewed-fixture-secret", c.AccessToken); };
        f.Provider.PushFailure = null;
        var recovered = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default);
        var receipt = Assert.Single(recovered.Operations);
        Assert.Equal(input.RequestId, receipt.Id);
        Assert.Equal("succeeded", receipt.State);
        Assert.Null(receipt.ErrorCode);
        Assert.Null(receipt.Error);
        Assert.Equal("connection", recovered.ConnectionId);
        Assert.Equal(input.ExpectedHead, recovered.PublishedHead);
        Assert.Equal(1, f.Provider.Created);
        var pushes = f.Provider.Pushed;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", input, default);
        Assert.Equal(pushes, f.Provider.Pushed);
        Assert.Equal(1, f.Provider.Created);
        Assert.DoesNotContain("renewed-fixture-secret", CoreJson.Text(recovered));
    }
}
