using System.Reflection;
using System.Text.Json;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class ModulesCommandTests
{
    [Fact]
    public void FormatModuleImageTags_UsesContainerImageTags()
    {
        var module = new ModuleSummary
        {
            Containers =
            [
                new ModuleContainerSummary
                {
                    Key = "web",
                    Image = new ModuleImage { Tag = "1.0.0" },
                },
                new ModuleContainerSummary
                {
                    Key = "worker",
                    Image = new ModuleImage { Tag = "1.0.0" },
                },
                new ModuleContainerSummary
                {
                    Key = "jobs",
                    Image = new ModuleImage { Tag = "2.0.0" },
                },
            ],
        };

        Assert.Equal("1.0.0, 2.0.0", ModulesCommand.FormatModuleImageTags(module));
    }

    [Fact]
    public void FormatModuleImageTags_FallsBackToLegacyImageReference()
    {
        var module = new ModuleSummary
        {
            Image = new ModuleImage { Reference = "localhost:5000/acme/reports:2026.05" },
        };

        Assert.Equal("2026.05", ModulesCommand.FormatModuleImageTags(module));
    }

    [Fact]
    public void CreateSettingPrompt_JsonArrayStringDefault_RendersAsLiteralMarkup()
    {
        const string defaultValue = "[{\"id\":\"ada\",\"name\":\"Ada Lovelace\"}]";
        using var defaultJson = JsonDocument.Parse(JsonSerializer.Serialize(defaultValue));
        var setting = new InstallPlanSettingPrompt
        {
            ModuleId = "com.example.legacy",
            Key = "SAMPLE_JSON",
            Type = "string",
            Required = false,
            Default = defaultJson.RootElement.Clone(),
        };
        using var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
        var prompt = ModulesCommand.CreateSettingPrompt(setting);
        var writePrompt = typeof(TextPrompt<string>).GetMethod(
            "WritePrompt",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

        Assert.NotNull(writePrompt);
        var exception = Record.Exception(() => writePrompt?.Invoke(prompt, [console]));

        Assert.Null(exception);
        Assert.Contains("[{\"id\":\"ada\",\"name\":\"Ada", output.ToString());
        Assert.Contains("Lovelace\"}]", output.ToString());
    }
}
