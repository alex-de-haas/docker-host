using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppCodeExchangeHttpTests
{
    private const string AppId = "target.app";
    private const string OtherAppId = "other.app";

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaé")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public async Task Token_UnrelatedOrMalformedProofDoesNotBurnCode(string? codeVerifier)
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        using var rightful = CreateAppClient(host, AppId);
        using var refusal = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier });
        Assert.Equal(HttpStatusCode.Unauthorized, refusal.StatusCode);
        Assert.Equal("invalid_code", await ErrorCodeAsync(refusal));
        Assert.Null(Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes).ConsumedAt);
        Assert.Equal("code_proof_mismatch", Assert.Single(await ExchangeAuditAsync(host)).Outcome);
        await AssertAuditContainsNoSecretsAsync(host, code, codeVerifier, AuthCodeProof.Challenge, AuthCodeProof.Verifier);
        using var exchanged = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchanged.EnsureSuccessStatusCode();
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("consumed")]
    public async Task Token_WrongProofCannotDiscloseCodeLifecycle(string state)
    {
        var clock = new Clock();
        await using var host = await CreateHostAsync(clock);
        var code = await IssueCodeAsync(host);
        using var rightful = CreateAppClient(host, AppId);
        if (state == "expired") clock.UtcNow = clock.UtcNow.AddMinutes(6);
        else
        {
            using var first = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            first.EnsureSuccessStatusCode();
        }
        using var refused = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = new string('z', 43) });
        Assert.Equal("invalid_code", await ErrorCodeAsync(refused));
        using var correct = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        Assert.Equal(state == "expired" ? "code_expired" : "code_consumed", await ErrorCodeAsync(correct));
    }

    [Fact]
    public async Task Token_LegacyUnboundRecordCannotBecomeAGrant()
    {
        await using var host = await CreateHostAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppAuthCodeStore>().AppendCodeAsync(
            new("legacy-code", AppId, "user", "http://target.example.test/callback", now, now.AddMinutes(5), null), now);
        using var rightful = CreateAppClient(host, AppId);
        using var refused = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code = "legacy-code", codeVerifier = AuthCodeProof.Verifier });
        Assert.Equal("invalid_code", await ErrorCodeAsync(refused));
        Assert.Null(Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes).ConsumedAt);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
    }

    [Fact]
    public async Task Token_ConcurrentUnrelatedProofsCannotBurnOrDiscloseTheRightfulExchange()
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        using var app = CreateAppClient(host, AppId);
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 16).Select(async index =>
        {
            var correct = index % 2 == 0;
            using var response = await app.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = correct ? AuthCodeProof.Verifier : new string('z', 43) });
            return (correct, response.StatusCode, Error: response.IsSuccessStatusCode ? null : await ErrorCodeAsync(response));
        }));
        Assert.Single(outcomes, outcome => outcome.StatusCode == HttpStatusCode.OK);
        Assert.All(outcomes.Where(outcome => !outcome.correct), outcome => Assert.Equal("invalid_code", outcome.Error));
        Assert.Equal(7, outcomes.Count(outcome => outcome.correct && outcome.Error == "code_consumed"));
        Assert.Single((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
        await AssertAuditContainsNoSecretsAsync(host, code, AuthCodeProof.Verifier, AuthCodeProof.Challenge, new string('z', 43));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("invalid")]
    [InlineData("core-session")]
    [InlineData("cookie")]
    public async Task Token_RequiresAppServiceCredentialAndPreservesCode(string credential)
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        using var client = host.CreateClient();
        var invalidToken = credential switch { "invalid" => "not-a-service-token", "core-session" => "browser-session", _ => null };
        if (invalidToken is not null) client.DefaultRequestHeaders.Authorization = new("Bearer", invalidToken);
        if (credential == "cookie") client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        using var refusal = await client.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(HttpStatusCode.Unauthorized, refusal.StatusCode);
        Assert.Equal("app_service_token_invalid", await ErrorCodeAsync(refusal));
        Assert.Null(Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes).ConsumedAt);
        var audit = Assert.Single(await ExchangeAuditAsync(host));
        Assert.Equal("app_service_token_invalid", audit.Outcome);
        Assert.Equal(AppId, audit.ResourceId);
        Assert.Equal(AppId, audit.Details["codeAppId"]);
        Assert.False(audit.Details.ContainsKey("callingAppId"));
        await AssertAuditContainsNoSecretsAsync(host, code, invalidToken);

        using var rightful = CreateAppClient(host, AppId);
        using var exchange = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchange.EnsureSuccessStatusCode();
        Assert.StartsWith("hostyg_", (await exchange.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
    }

    [Fact]
    public async Task Token_ForeignAppCannotBurnCode_AndRefusalAuditContainsOnlyAppIdsAndReason()
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        using var foreign = CreateAppClient(host, OtherAppId);
        using var refusal = await foreign.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(HttpStatusCode.Unauthorized, refusal.StatusCode);
        Assert.Equal("invalid_code", await ErrorCodeAsync(refusal));
        Assert.Null(Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes).ConsumedAt);
        var audit = Assert.Single(await ExchangeAuditAsync(host));
        Assert.Equal("code_app_mismatch", audit.Outcome);
        Assert.Equal(OtherAppId, audit.Details["callingAppId"]);
        Assert.Equal(AppId, audit.Details["codeAppId"]);
        Assert.Equal("code_app_mismatch", audit.Details["reason"]);
        await AssertAuditContainsNoSecretsAsync(host, code, foreign.DefaultRequestHeaders.Authorization!.Parameter);

        using var rightful = CreateAppClient(host, AppId);
        using var exchange = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchange.EnsureSuccessStatusCode();
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("consumed")]
    [InlineData("unknown")]
    public async Task Token_ForeignAppAlwaysGetsInvalidCodeWithoutLifecycleDisclosure(string state)
    {
        var clock = new Clock();
        await using var host = await CreateHostAsync(clock);
        var code = await IssueCodeAsync(host);
        using var rightful = CreateAppClient(host, AppId);
        if (state == "expired") clock.UtcNow = clock.UtcNow.AddMinutes(6);
        if (state == "consumed")
        {
            using var first = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            first.EnsureSuccessStatusCode();
        }
        if (state == "unknown") code = "unknown-code";
        using var foreign = CreateAppClient(host, OtherAppId);
        using var refusal = await foreign.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(HttpStatusCode.Unauthorized, refusal.StatusCode);
        Assert.Equal("invalid_code", await ErrorCodeAsync(refusal));
        var audit = Assert.Single(await ExchangeAuditAsync(host));
        Assert.Equal(state == "unknown" ? "invalid_code" : "code_app_mismatch", audit.Outcome);
        Assert.Equal(OtherAppId, audit.Details["callingAppId"]);
        if (state == "unknown") Assert.False(audit.Details.ContainsKey("codeAppId"));
        if (state != "unknown")
        {
            using var rightfulRefusal = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            Assert.Equal(state == "expired" ? "code_expired" : "code_consumed", await ErrorCodeAsync(rightfulRefusal));
        }
    }

    [Theory]
    [InlineData("expired", "code_expired")]
    [InlineData("consumed", "code_consumed")]
    [InlineData("unknown", "invalid_code")]
    [InlineData("missing", "invalid_code")]
    public async Task Token_RightfulAppPreservesExistingCodeErrorsAndAuditsRefusal(string state, string expectedError)
    {
        var clock = new Clock();
        await using var host = await CreateHostAsync(clock);
        string? code = await IssueCodeAsync(host);
        using var rightful = CreateAppClient(host, AppId);
        if (state == "expired") clock.UtcNow = clock.UtcNow.AddMinutes(6);
        if (state == "consumed")
        {
            using var first = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            first.EnsureSuccessStatusCode();
        }
        if (state == "unknown") code = "unknown-code";
        if (state == "missing") code = null;
        using var refusal = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(HttpStatusCode.Unauthorized, refusal.StatusCode);
        Assert.Equal(expectedError, await ErrorCodeAsync(refusal));
        var audit = Assert.Single(await ExchangeAuditAsync(host));
        Assert.Equal(expectedError, audit.Outcome);
        Assert.Equal(AppId, audit.Details["callingAppId"]);
        Assert.Equal(state is "unknown" or "missing" ? null : AppId, audit.ResourceId);
    }

    [Theory]
    [InlineData("disabled", "user_disabled")]
    [InlineData("unassigned", "app_access_denied")]
    [InlineData("recovered", "token_revoked")]
    public async Task Token_RechecksAccessAndAuthRevision_AndAuditsPolicyRefusals(string change, string expectedError)
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Users = state.Users.Select(user => user with { Disabled = change == "disabled", AuthRevision = change == "recovered" ? "new-revision" : user.AuthRevision }).ToArray(),
            Assignments = change == "unassigned" ? [] : state.Assignments,
        });
        using var rightful = CreateAppClient(host, AppId);
        using var refusal = await rightful.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(change == "recovered" ? HttpStatusCode.Unauthorized : HttpStatusCode.Forbidden, refusal.StatusCode);
        Assert.Equal(expectedError, await ErrorCodeAsync(refusal));
        var audit = Assert.Single(await ExchangeAuditAsync(host));
        Assert.Equal(expectedError, audit.Outcome);
        Assert.Equal(AppId, audit.ResourceId);
        Assert.Equal(AppId, audit.Details["callingAppId"]);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
    }

    [Fact]
    public async Task Token_ConcurrentForeignAndRightfulRequestsConsumeOnlyOnce()
    {
        await using var host = await CreateHostAsync();
        var code = await IssueCodeAsync(host);
        using var rightful = CreateAppClient(host, AppId);
        using var foreign = CreateAppClient(host, OtherAppId);
        var attempts = Enumerable.Range(0, 16).Select(async index =>
        {
            var isRightful = index % 2 == 0;
            using var response = await (isRightful ? rightful : foreign).PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            return (isRightful, response.StatusCode, Error: response.IsSuccessStatusCode ? null : await ErrorCodeAsync(response));
        });
        var results = await Task.WhenAll(attempts);

        Assert.Single(results, result => result.StatusCode == HttpStatusCode.OK);
        Assert.All(results.Where(result => !result.isRightful), result => Assert.Equal("invalid_code", result.Error));
        Assert.All(results.Where(result => result.isRightful && result.StatusCode != HttpStatusCode.OK), result => Assert.Equal("code_consumed", result.Error));
        Assert.Single((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
        var audit = await ExchangeAuditAsync(host);
        Assert.Equal(15, audit.Count);
        Assert.Equal(8, audit.Count(record => record.Outcome == "code_app_mismatch"));
        Assert.Equal(7, audit.Count(record => record.Outcome == "code_consumed"));
        await AssertAuditContainsNoSecretsAsync(host, code, rightful.DefaultRequestHeaders.Authorization!.Parameter, foreign.DefaultRequestHeaders.Authorization!.Parameter);
    }

    private static HttpClient CreateAppClient(CoreHttpHarness host, string appId)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        return client;
    }

    private static async Task<string> IssueCodeAsync(CoreHttpHarness host)
        => (await host.Services.GetRequiredService<AppIdentityService>().CreateAuthorizationCodeAsync(AppId, "user", "http://target.example.test/callback", AuthCodeProof.Challenge, "S256")).Code;

    private static async Task<string?> ErrorCodeAsync(HttpResponseMessage response)
        => (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString();

    private static async Task<IReadOnlyList<AuditRecord>> ExchangeAuditAsync(CoreHttpHarness host)
        => (await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync()).Where(record => record.Action == "auth.app-code.exchange").ToArray();

    private static async Task AssertAuditContainsNoSecretsAsync(CoreHttpHarness host, params string?[] secrets)
    {
        var auditText = await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath);
        foreach (var secret in secrets.Where(secret => !string.IsNullOrEmpty(secret))) Assert.DoesNotContain(secret!, auditText);
    }

    private static async Task<CoreHttpHarness> CreateHostAsync(IClock? clock = null)
    {
        var host = await CoreHttpHarness.StartAsync(clock);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("user", "user@example.test", "User", "host.user", false, now, now)], [], [new(AppId, "user", now)],
            [new("browser-session", "user", now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        foreach (var appId in new[] { AppId, OtherAppId })
            await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(appId, "Test app", null,
                "1.0.0", "runtime", false, "manifest", null, null, "dev", "installed", "stopped", null, null, [],
                new Dictionary<string, AppSettingValue>(), [], [], [new("web", "http", "http://target.example.test", true)], now, now));
        return host;
    }

    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }
}
