using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentDockerPluginsTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-plugin-test-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Configure_ImportsPluginLocationWithoutParentCredentialsAndPreservesChildConfiguration()
    {
        var plugins = Path.Combine(root, "parent", "cli-plugins"); Directory.CreateDirectory(plugins);
        var binary = Path.Combine(plugins, "docker-buildx"); File.WriteAllText(binary, "fixture");
        var child = Path.Combine(root, "child"); var configPath = Path.Combine(child, ".docker", "config.json");
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        File.WriteAllText(configPath, "{\"auths\":{\"registry.example\":{\"auth\":\"child-owned\"}},\"cliPluginsExtraDirs\":[\"/child/plugins\"]}");
        var inventory = new JsonArray(new JsonObject { ["Name"] = "buildx", ["Path"] = binary,
            ["Token"] = "parent-secret-never-import" }).ToJsonString();

        await CoreEnvironmentDockerPlugins.ConfigureAsync(child, inventory);
        await CoreEnvironmentDockerPlugins.ConfigureAsync(child, inventory);

        var text = File.ReadAllText(configPath); var config = JsonNode.Parse(text)!;
        Assert.Equal("child-owned", config["auths"]!["registry.example"]!["auth"]!.GetValue<string>());
        Assert.Equal(new[] { "/child/plugins", plugins }, config["cliPluginsExtraDirs"]!.AsArray().Select(value => value!.GetValue<string>()));
        Assert.DoesNotContain("parent-secret", text);
        Assert.True(File.Exists(binary));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Configure_Unix_CreatesAndReplacesConfigurationWithOwnerOnlyPermissions(bool existingConfig)
    {
        if (OperatingSystem.IsWindows()) return;

        var plugins = Path.Combine(root, "parent", "cli-plugins");
        Directory.CreateDirectory(plugins);
        var binary = Path.Combine(plugins, "docker-buildx");
        File.WriteAllText(binary, "fixture");
        var child = Path.Combine(root, "child");
        var configPath = Path.Combine(child, ".docker", "config.json");
        var ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if (existingConfig)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
            File.WriteAllText(configPath, "{\"auths\":{\"registry.example\":{\"auth\":\"child-owned\"}}}");
            File.SetUnixFileMode(configPath, ownerOnly);
        }
        var inventory = new JsonArray(new JsonObject { ["Path"] = binary }).ToJsonString();

        for (var attempt = 0; attempt < 2; attempt++)
        {
            await CoreEnvironmentDockerPlugins.ConfigureAsync(child, inventory);

            Assert.Equal(ownerOnly, File.GetUnixFileMode(configPath));
            var config = JsonNode.Parse(File.ReadAllText(configPath))!;
            Assert.Equal(plugins, config["cliPluginsExtraDirs"]![0]!.GetValue<string>());
            if (existingConfig)
                Assert.Equal("child-owned", config["auths"]!["registry.example"]!["auth"]!.GetValue<string>());
            Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(configPath)!, "*.tmp"));
        }
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("[{\"Name\":\"buildx\",\"Path\":\"relative/docker-buildx\"}]")]
    [InlineData("[{\"Name\":\"broken\",\"Err\":\"unavailable\"}]")]
    public async Task Configure_NoInstalledPlugin_DoesNotCreateChildConfiguration(string inventory)
    {
        var child = Path.Combine(root, "child");
        await CoreEnvironmentDockerPlugins.ConfigureAsync(child, inventory);
        Assert.False(Directory.Exists(child));
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
