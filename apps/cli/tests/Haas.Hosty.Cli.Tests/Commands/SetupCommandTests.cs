using System.Text.Json;
using Haas.Hosty.Cli;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class SetupCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string ListVariable = "HOSTY_DISTRIBUTION_APPS_PATH";
    private readonly string? previousRoot;
    private readonly string? previousListPath;
    private readonly string rootDirectory;

    public SetupCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        previousListPath = Environment.GetEnvironmentVariable(ListVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-setup-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
        // Pin the distribution list to a test file: the walk would otherwise find the repository's
        // own distribution-apps.json (tests run from inside the repo tree).
        Environment.SetEnvironmentVariable(ListVariable, WriteDistributionList("""
            {
              "schemaVersion": "distribution-apps.0.1",
              "apps": [
                { "id": "hosty.shell", "title": "Hosty Shell", "manifestRef": "x", "defaultEnabled": true },
                { "id": "hosty.telemetry", "title": "Telemetry", "manifestRef": "x", "defaultEnabled": false },
                { "id": "hosty.marketplace", "title": "Marketplace", "manifestRef": "x", "defaultEnabled": true }
              ]
            }
            """));
    }

    [Fact]
    public async Task Setup_WithoutFlagsOnNonInteractiveConsole_FailsWithUsage()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("Interactive setup needs a terminal", output.ToString());
    }

    [Fact]
    public async Task Setup_Yes_PinsReleaseDefaults()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--yes"], console);

        Assert.Equal(0, exitCode);
        var choices = ReadChoicesDocument();
        Assert.Equal("bootstrap-choices.0.1", choices.GetProperty("schemaVersion").GetString());
        Assert.True(choices.GetProperty("apps").GetProperty("hosty.shell").GetProperty("enabled").GetBoolean());
        Assert.False(choices.GetProperty("apps").GetProperty("hosty.telemetry").GetProperty("enabled").GetBoolean());
        Assert.True(choices.GetProperty("apps").GetProperty("hosty.marketplace").GetProperty("enabled").GetBoolean());
        // No substring assert on the styled console output: line wrapping re-emits ANSI color codes
        // mid-path at width-dependent positions. The saved file itself is the observable outcome.
        Assert.True(File.Exists(ChoicesPath()));
        Assert.Contains("Saved to", output.ToString());
    }

    [Fact]
    public async Task Setup_WithAndWithout_AdjustEffectiveSelection()
    {
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["setup", "--with", "hosty.telemetry", "--without", "hosty.marketplace"], console);

        Assert.Equal(0, exitCode);
        var apps = ReadChoicesDocument().GetProperty("apps");
        Assert.True(apps.GetProperty("hosty.telemetry").GetProperty("enabled").GetBoolean());
        Assert.False(apps.GetProperty("hosty.marketplace").GetProperty("enabled").GetBoolean());
        Assert.True(apps.GetProperty("hosty.shell").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Setup_ConflictingWithAndWithout_FailsWithUsage()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["setup", "--with", "hosty.telemetry", "--without", "hosty.telemetry"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("appears in both", output.ToString());
    }

    [Fact]
    public async Task Setup_UnknownAppId_FailsListingKnownIds()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--with", "hosty.unknown"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("Unknown app id 'hosty.unknown'", output.ToString());
        Assert.Contains("hosty.shell", output.ToString());
    }

    [Fact]
    public async Task Setup_TelemetryToggle_SyncsObservabilityLaunchSetting()
    {
        var (console, _) = CreateConsole();

        Assert.Equal(0, await CommandLine.RunAsync(["setup", "--with", "hosty.telemetry"], console));
        var environment = HostyEnvironment.Current();
        Assert.Equal("true", new LaunchSettingsStore(environment).Load().HostyObservabilityEnabled);

        Assert.Equal(0, await CommandLine.RunAsync(["setup", "--without", "hosty.telemetry"], console));
        Assert.Equal("false", new LaunchSettingsStore(environment).Load().HostyObservabilityEnabled);
    }

    [Fact]
    public async Task Setup_PreservesInertChoicesForUnknownIds()
    {
        var choicesPath = ChoicesPath();
        Directory.CreateDirectory(Path.GetDirectoryName(choicesPath)!);
        await File.WriteAllTextAsync(choicesPath, """
            { "schemaVersion": "bootstrap-choices.0.1", "apps": { "hosty.retired": { "enabled": true } } }
            """);
        var (console, _) = CreateConsole();

        Assert.Equal(0, await CommandLine.RunAsync(["setup", "--yes"], console));

        var apps = ReadChoicesDocument().GetProperty("apps");
        Assert.True(apps.GetProperty("hosty.retired").GetProperty("enabled").GetBoolean());
        Assert.True(apps.GetProperty("hosty.shell").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Setup_ExistingChoicesOutrankDefaultsInEffectiveBase()
    {
        var choicesPath = ChoicesPath();
        Directory.CreateDirectory(Path.GetDirectoryName(choicesPath)!);
        await File.WriteAllTextAsync(choicesPath, """
            { "schemaVersion": "bootstrap-choices.0.1", "apps": { "hosty.marketplace": { "enabled": false } } }
            """);
        var (console, _) = CreateConsole();

        // --yes keeps the current effective selection: the marketplace choice stays disabled even
        // though the release default is enabled.
        Assert.Equal(0, await CommandLine.RunAsync(["setup", "--yes"], console));

        Assert.False(ReadChoicesDocument().GetProperty("apps").GetProperty("hosty.marketplace").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Setup_CorruptedChoicesFile_WarnsAndRewrites()
    {
        var choicesPath = ChoicesPath();
        Directory.CreateDirectory(Path.GetDirectoryName(choicesPath)!);
        await File.WriteAllTextAsync(choicesPath, "{ not json");
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--yes"], console);

        Assert.Equal(0, exitCode);
        Assert.Contains("could not be parsed", output.ToString());
        Assert.True(ReadChoicesDocument().GetProperty("apps").GetProperty("hosty.shell").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Setup_List_ShowsSelectionWithoutWriting()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--list"], console);

        Assert.Equal(0, exitCode);
        Assert.Contains("hosty.telemetry", output.ToString());
        Assert.False(File.Exists(ChoicesPath()));
    }

    [Fact]
    public async Task Setup_LegacyObservabilitySetting_EnablesTelemetryInEffectiveBase()
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();
        store.Set(LaunchSettingDefinitions.HostyObservabilityEnabled, "true");
        var (console, _) = CreateConsole();

        Assert.Equal(0, await CommandLine.RunAsync(["setup", "--yes"], console));

        Assert.True(ReadChoicesDocument().GetProperty("apps").GetProperty("hosty.telemetry").GetProperty("enabled").GetBoolean());
    }

    private string ChoicesPath()
        => Path.Combine(rootDirectory, "core", "bootstrap-choices.json");

    private JsonElement ReadChoicesDocument()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(ChoicesPath()));
        return document.RootElement.Clone();
    }

    private string WriteDistributionList(string json)
    {
        Directory.CreateDirectory(rootDirectory);
        var path = Path.Combine(rootDirectory, "test-distribution-apps.json");
        File.WriteAllText(path, json);
        return path;
    }

    private static (IAnsiConsole Console, StringWriter Output) CreateConsole()
    {
        var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
        return (console, output);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);
        Environment.SetEnvironmentVariable(ListVariable, previousListPath);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }
}
