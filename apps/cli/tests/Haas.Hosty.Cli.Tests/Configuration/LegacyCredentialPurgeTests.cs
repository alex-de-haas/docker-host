namespace Haas.Hosty.Cli.Tests.Configuration;

using System.Text.Json;
using Haas.Hosty.Cli.Configuration;

// Removing `hosty login` without this would have left a live bearer token on every machine that had
// signed in, with the only cleanup path (`hosty logout`) removed in the same change.
public class LegacyCredentialPurgeTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-purge-{Guid.NewGuid():N}");

    private string ConfigDirectory => Path.Combine(root, "config");

    [Fact]
    public void SaysNothingWhenThereIsNothingToRemove()
    {
        // The common case by far — every machine that never signed in, and every machine after the
        // first run. A notice there would be noise on every single command.
        Directory.CreateDirectory(ConfigDirectory);

        Assert.Null(LegacyCredentialPurge.Run(ConfigDirectory));
    }

    [Fact]
    public void RemovesTheTokenFileAndTheContextIndex()
    {
        Seed(contexts: ["prod"], tokens: ["prod"]);

        var notice = LegacyCredentialPurge.Run(ConfigDirectory);

        Assert.NotNull(notice);
        Assert.False(File.Exists(Path.Combine(ConfigDirectory, "contexts.json")));
        Assert.False(File.Exists(Path.Combine(ConfigDirectory, "contexts", "prod.token")));
    }

    [Fact]
    public void SaysTheCredentialIsStillValidOnTheHost()
    {
        // Deleting the local copy does not revoke anything. Implying otherwise would leave an operator
        // believing a possibly-leaked credential was dead.
        Seed(contexts: ["prod"], tokens: ["prod"]);

        var notice = LegacyCredentialPurge.Run(ConfigDirectory)!;

        Assert.Contains("still valid", notice, StringComparison.Ordinal);
        Assert.Contains("revoke", notice, StringComparison.Ordinal);
    }

    [Fact]
    public void RunsOnceAndIsSilentAfterwards()
    {
        Seed(contexts: ["prod"], tokens: ["prod"]);

        Assert.NotNull(LegacyCredentialPurge.Run(ConfigDirectory));
        Assert.Null(LegacyCredentialPurge.Run(ConfigDirectory));
    }

    [Fact]
    public void CleansUpEvenWhenOnlyTheTokenFileSurvived()
    {
        // A half-state is reachable: the index could have been deleted by hand, or never written on a
        // platform that fell back to a file. The token is the part that matters.
        Seed(contexts: null, tokens: ["prod", "staging"]);

        Assert.NotNull(LegacyCredentialPurge.Run(ConfigDirectory));
        Assert.False(Directory.Exists(Path.Combine(ConfigDirectory, "contexts")));
    }

    [Fact]
    public void ACorruptIndexStillGetsRemoved()
    {
        // It cannot name the keychain entries to look for, but leaving the file — and the token beside
        // it — because it failed to parse would be the worst outcome available.
        Directory.CreateDirectory(Path.Combine(ConfigDirectory, "contexts"));
        File.WriteAllText(Path.Combine(ConfigDirectory, "contexts.json"), "{ not json");
        File.WriteAllText(Path.Combine(ConfigDirectory, "contexts", "prod.token"), "hostyat_secret");

        Assert.NotNull(LegacyCredentialPurge.Run(ConfigDirectory));
        Assert.False(File.Exists(Path.Combine(ConfigDirectory, "contexts.json")));
        Assert.False(File.Exists(Path.Combine(ConfigDirectory, "contexts", "prod.token")));
    }

    [Fact]
    public void LeavesTheRestOfTheConfigDirectoryAlone()
    {
        // Launch settings and the auth config live in the same directory and have nothing to do with
        // this; a purge that took them would break the local install it is running inside.
        Seed(contexts: ["prod"], tokens: ["prod"]);
        var launch = Path.Combine(ConfigDirectory, "launch.env");
        File.WriteAllText(launch, "HOSTY_CORE_PORT=7070");

        LegacyCredentialPurge.Run(ConfigDirectory);

        Assert.True(File.Exists(launch));
    }

    private void Seed(string[]? contexts, string[] tokens)
    {
        Directory.CreateDirectory(Path.Combine(ConfigDirectory, "contexts"));
        if (contexts is not null)
        {
            var document = new { current = contexts[0], contexts = contexts.Select(name => new { name, origin = $"https://{name}.test" }) };
            File.WriteAllText(
                Path.Combine(ConfigDirectory, "contexts.json"),
                JsonSerializer.Serialize(document));
        }

        foreach (var token in tokens)
        {
            File.WriteAllText(Path.Combine(ConfigDirectory, "contexts", $"{token}.token"), "hostyat_secret");
        }
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }

        GC.SuppressFinalize(this);
    }
}
