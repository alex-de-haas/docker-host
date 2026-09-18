using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed class InstallationApprovalStoreTests
{
    [Fact]
    public void ApprovalRequiresPageNonceAndSameBrowserSession_AndIsSingleUse()
    {
        var clock = new TestClock();
        var store = new InstallationApprovalStore(clock);
        var entry = store.Add(NewRequest(clock));
        store.Submit(entry, new(new Dictionary<string, string?> { ["secret"] = "value" }));
        var nonce = store.IssueNonce(entry, "session-a");
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, entry.Id, "session-a", true));
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, nonce, "session-b", true));
        store.Decide(entry, nonce, "session-a", true);
        Assert.Equal("executing", entry.Status);
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, nonce, "session-a", true));
        Assert.Throws<AppLifecycleException>(() => store.Submit(entry, new(Autostart: false)));
        store.Complete(entry, null);
        Assert.Equal("succeeded", entry.Status);
        Assert.Null(entry.Settings);
        Assert.Null(entry.IdentityToken);
    }

    [Fact]
    public void SubmissionCopiesSettings_AndStatusNeverExposesDecisionCredential()
    {
        var clock = new TestClock();
        var store = new InstallationApprovalStore(clock);
        var entry = store.Add(NewRequest(clock));
        var settings = new Dictionary<string, string?> { ["TOKEN"] = "secret" };
        store.Submit(entry, new(settings));
        settings["TOKEN"] = "replaced";
        var nonce = store.IssueNonce(entry, "session");
        Assert.Equal("secret", entry.Settings!["TOKEN"]);
        var json = CoreJson.Text(store.View(entry, "https://core.example"));
        Assert.DoesNotContain(nonce, json);
        Assert.DoesNotContain("secret", json);
        Assert.DoesNotContain("identity-token", json);
    }

    [Fact]
    public void ExpiredRequestCannotBeApproved_AndAnotherPageInvalidatesOldNonce()
    {
        var clock = new TestClock();
        var store = new InstallationApprovalStore(clock);
        var entry = store.Add(NewRequest(clock));
        store.Submit(entry, new());
        var first = store.IssueNonce(entry, "session");
        var second = store.IssueNonce(entry, "session");
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, first, "session", true));
        clock.UtcNow += InstallationApprovalStore.Lifetime;
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, second, "session", true));
    }

    [Fact]
    public void ConfirmationHtmlEscapesAppSuppliedText()
    {
        var clock = new TestClock();
        var entry = NewRequest(clock);
        entry.Status = "pending";
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.DoesNotContain("<script>", html);
        Assert.Contains("&lt;script&gt;", html);
    }

    [Theory]
    [InlineData("https://core.example", "same-origin", true)]
    [InlineData("https://shell.example", "same-site", false)]
    [InlineData("https://evil.example", "cross-site", false)]
    [InlineData("", "same-origin", false)]
    public void DecisionRefusesOtherOriginsIncludingShell(string origin, string site, bool accepted)
    {
        var request = new DefaultHttpContext().Request;
        request.Scheme = "https";
        request.Host = new HostString("core.example");
        request.ContentType = "application/x-www-form-urlencoded";
        request.Headers.Origin = origin;
        request.Headers["Sec-Fetch-Site"] = site;
        Assert.Equal(accepted, InstallationApprovalEndpoints.IsSameOriginDecision(request));
    }

    [Fact]
    public void LoginReturnsToCoreConfirmationWithoutShell()
    {
        var path = "/install/confirm/" + new string('a', 48);
        Assert.Equal(path, AuthEndpoints.ResolveLoginRedirect(path, null));
    }

    private static InstallationApproval NewRequest(TestClock clock) => new()
    {
        UserId = "admin", CallerName = "<script>malicious()</script>", IdentityToken = "identity-token",
        ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
    };
    private sealed class TestClock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }
}
