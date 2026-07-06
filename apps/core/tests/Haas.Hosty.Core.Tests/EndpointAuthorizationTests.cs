using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core.Tests;

// Authorization matrix guardrail. C-M9 shipped because a state-changing /api POST (install/plan) was
// session-authenticated but silently missed `requireCsrf: true`, unlike its apply twin. Rather than a
// full HTTP harness, this asserts the invariant mechanically over the endpoint source: every
// state-changing (POST/PUT/DELETE) /api route that authenticates with a session MUST require CSRF.
// A new session-guarded mutation that forgets the header now fails this test instead of review.
public sealed class EndpointAuthorizationTests
{
    private static readonly string[] EndpointFiles =
    [
        "AuthEndpoints.cs",
        "AppBackupEndpoints.cs",
        "NotificationEndpoints.cs",
        "GlobalMountEndpoints.cs",
        "UserManagementEndpoints.cs",
        "AuthBootstrapEndpoints.cs",
        "LifecycleEndpoints.cs",
        "DomainEndpoints.cs",
    ];

    [Fact]
    public void EverySessionAuthenticatedApiMutation_RequiresCsrf()
    {
        var offenders = new List<string>();
        foreach (var file in EndpointFiles)
        {
            foreach (var registration in ExtractRegistrations(ReadSource(file)))
            {
                // Only state-changing /api routes authenticated by a Core session are in scope; control
                // routes (ControlSecret), GETs, and non-session auth (service tokens, trusted proxy) are
                // exempt by design.
                var isApiMutation = Regex.IsMatch(registration, "app\\.Map(Post|Put|Delete)\\(\"/api/");
                var usesSession = registration.Contains("RequireSessionAsync", StringComparison.Ordinal) ||
                    registration.Contains("RequireAdminSessionAsync", StringComparison.Ordinal);
                if (!isApiMutation || !usesSession)
                {
                    continue;
                }

                if (!registration.Contains("requireCsrf: true", StringComparison.Ordinal))
                {
                    offenders.Add($"{file}: {FirstLine(registration)}");
                }
            }
        }

        Assert.True(
            offenders.Count == 0,
            "Session-authenticated /api mutations missing `requireCsrf: true`:\n" + string.Join("\n", offenders));
    }

    // Splits a source file into per-endpoint registration segments: each spans from one `app.Map…(` call
    // to the next, so CSRF/auth tokens are attributed to the route they belong to.
    private static IEnumerable<string> ExtractRegistrations(string source)
    {
        var matches = Regex.Matches(source, "app\\.Map(Get|Post|Put|Delete)\\(");
        for (var i = 0; i < matches.Count; i++)
        {
            var start = matches[i].Index;
            var end = i + 1 < matches.Count ? matches[i + 1].Index : source.Length;
            yield return source[start..end];
        }
    }

    private static string FirstLine(string registration)
        => registration.Split('\n', 2)[0].Trim();

    private static string ReadSource(string fileName)
        => File.ReadAllText(Path.Combine(CoreSourceDirectory(), fileName));

    private static string CoreSourceDirectory([CallerFilePath] string callerFilePath = "")
    {
        // Walk up from this test file to the repo root (identified by the Core source dir) so the check
        // resolves the same way on any machine and in CI.
        var directory = Path.GetDirectoryName(callerFilePath);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory, "apps", "core", "src", "Haas.Hosty.Core");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            directory = Path.GetDirectoryName(directory);
        }

        throw new DirectoryNotFoundException("Could not locate apps/core/src/Haas.Hosty.Core from the test path.");
    }
}
