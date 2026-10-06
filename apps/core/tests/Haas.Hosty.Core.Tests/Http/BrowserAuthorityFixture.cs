using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// In-process fixtures only. Browser QA separately uses normal password login.
internal static class BrowserAuthorityFixture
{
    internal static async Task<AppIdentityTokenResult> Grant(CoreHttpHarness host, string appId, string userId, string browserId = "browser-session")
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Where(s => s.Id != browserId).Append(new AuthSessionRecord(browserId, userId, now,
                now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")).ToArray(),
        });
        var code = Guid.NewGuid().ToString("N");
        await host.Services.GetRequiredService<AppAuthCodeStore>().AppendCodeAsync(new(code, appId, userId,
            "http://app.test/callback", now, now.AddMinutes(5), null, browserId, ActivityAuthorized: true, CodeChallenge: AuthCodeProof.Challenge), now);
        return await host.Services.GetRequiredService<AppIdentityService>().ExchangeCodeAsync(code, appId, AuthCodeProof.Verifier);
    }
    internal static async Task Approve(CoreHttpHarness host, string appId, string userId, string sessionId = "session-one", string browserId = "browser-session")
    {
        var authority = host.Services.GetRequiredService<AssistantSessionAuthority>();
        var nonce = await authority.CreateDecisionAsync(appId, sessionId, userId, browserId, default);
        await authority.DecideAsync(nonce, appId, sessionId, userId, browserId, "approve", default);
    }
}
