using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Initialization;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class InitCommandTests
{
    [Fact]
    public void Parse_ExplicitCoreOnly_IsDifferentFromRecommendedDefaults()
    {
        Assert.Null(InitCommand.Parse(["--yes"]).Apps);
        Assert.Empty(InitCommand.Parse(["--core-only"]).Apps!);
        var options = InitCommand.Parse(["--apps", "hosty.shell,hosty.marketplace", "--port", "23456", "--app-port", "hosty.shell:web:http=23457", "--no-open"]);
        Assert.Equal(23456, options.Port);
        Assert.Equal(23457, Assert.Single(options.AppPorts).Port);
        Assert.True(options.NoOpen);
    }
    [Theory]
    [InlineData("0")]
    [InlineData("70700")]
    [InlineData("shell")]
    public void Parse_InvalidCorePort_IsUsageError(string value)
        => Assert.Throws<CommandUsageException>(() => InitCommand.Parse(["--port", value]));

    [Fact]
    public async Task Start_FreshRoot_ExplainsInitWithoutDownloadingCore()
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-init-guard-" + Guid.NewGuid().ToString("N"));
        using var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(output), Ansi = AnsiSupport.No, ColorSystem = ColorSystemSupport.NoColors });
        try
        {
            Assert.Equal(1, await CommandLine.RunAsync(["--data-root", root, "start"], console));
            Assert.Contains("hosty init", output.ToString());
            Assert.False(Directory.Exists(Path.Combine(root, "core", "bin")));
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }

    [Fact]
    public void ExistingHistory_AndPendingIntent_AreDistinct()
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-init-history-" + Guid.NewGuid().ToString("N"));
        try
        {
            Assert.False(InitializationFiles.CanStart(root));
            Directory.CreateDirectory(Path.Combine(root, "core"));
            File.WriteAllText(Path.Combine(root, "core", "distribution-seed.json"), "{}");
            Assert.True(InitializationFiles.CanStart(root));
            InitializationFiles.Request(root);
            Assert.False(InitializationFiles.CanStart(root));
        }
        finally { Directory.Delete(root, true); }
    }
}
