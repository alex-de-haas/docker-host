using System.Reflection;
using System.Text.Json;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class ModulesCommandTests
{
    [Fact]
    public void CreateSettingPrompt_JsonArrayStringDefault_RendersAsLiteralMarkup()
    {
        const string defaultValue = "[{\"id\":\"ada\",\"name\":\"Ada Lovelace\"}]";
        using var defaultJson = JsonDocument.Parse(JsonSerializer.Serialize(defaultValue));
        var setting = new InstallPlanSettingPrompt
        {
            ModuleId = "com.haas.demo-module",
            Key = "DEMO_PEOPLE_JSON",
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
