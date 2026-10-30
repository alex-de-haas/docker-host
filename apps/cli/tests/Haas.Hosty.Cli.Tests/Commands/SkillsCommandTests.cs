using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class SkillsCommandTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-skills-list-tests-{Guid.NewGuid():N}");
    private static readonly string Description = "Use [review] for C# tests.\n" + new string('x', 130) + " full description tail";
    private static readonly string Catalog = JsonSerializer.Serialize(new
    {
        skills = new[]
        {
            new { id = "full-stable-skill-id", name = "csharp-xunit", sourceKind = "git", description = Description },
        },
    });

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task List_RendersReadableTableWithLiteralAbbreviatedDescription(bool explicitFormat)
    {
        var args = explicitFormat ? new[] { "--format", "table" } : [];
        var (exitCode, output) = await RunWithCatalogAsync(Catalog, args);

        Assert.Equal(0, exitCode);
        Assert.Contains("Skill", output);
        Assert.Contains("Source", output);
        Assert.Contains("Description", output);
        Assert.Contains("csharp-xunit", output);
        Assert.Contains("git", output);
        Assert.Contains("Use [review] for C# tests.", output);
        Assert.Contains("...", output);
        Assert.DoesNotContain("full description tail", output);
        Assert.DoesNotContain("\"skills\"", output);
        Assert.DoesNotContain("\u001b", output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task List_JsonPreservesCompleteCatalog()
    {
        var (exitCode, output) = await RunWithCatalogAsync(Catalog, ["--format", "json"]);

        Assert.Equal(0, exitCode);
        Assert.Equal(Catalog, output.Trim());
        using var document = JsonDocument.Parse(output);
        var skill = document.RootElement.GetProperty("skills")[0];
        Assert.Equal("full-stable-skill-id", skill.GetProperty("id").GetString());
        Assert.Equal(Description, skill.GetProperty("description").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task List_EmptyCatalogRespectsSelectedFormat(bool json)
    {
        var (exitCode, output) = await RunWithCatalogAsync("{\"skills\":[]}", json ? ["--format", "json"] : []);

        Assert.Equal(0, exitCode);
        Assert.Equal(json ? "{\"skills\":[]}" : "No skills installed.", output.Trim());
    }

    [Theory]
    [InlineData("--format")]
    [InlineData("--format", "yaml")]
    [InlineData("--unknown")]
    [InlineData("--format", "json", "unexpected")]
    public async Task List_InvalidArgumentsFailBeforeCoreDiscovery(params string[] args)
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["--data-root", root, "skills", "list", .. args], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("skills list accepts --format table|json.", output.ToString());
        Assert.DoesNotContain("Run hosty core start", output.ToString());
    }

    private async Task<(int ExitCode, string Output)> RunWithCatalogAsync(string body, string[] args)
        => await RunWithCoreAsync(["list", .. args], [new("GET", "/skills/", body)]);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Add_PreservesSelectionCommitAndOptionsAndRendersOnlyInstalledPackages(bool json)
    {
        var source = new { repository = "https://example.test/skills", @ref = "release", path = "guides" };
        var discovery = JsonSerializer.Serialize(new { repository = source.repository, @ref = source.@ref, commit = "observed-commit", skills = Array.Empty<object>() });
        var options = json ? new[] { "--format", "json" } : [];
        var (exitCode, output) = await RunWithCoreAsync([
            "add", source.repository, "--skill", "csharp-xunit", "--skill", "second", "--skill", "csharp-xunit",
            "--ref", source.@ref, "--path", source.path, .. options],
        [
            new("POST", "/skills/discover", discovery, AssertBody: body => CheckSelection(body, false)),
            new("POST", "/skills/install", Catalog, AssertBody: body => CheckSelection(body, true)),
        ]);
        Assert.Equal(0, exitCode);
        if (json) Assert.Equal(Catalog, output.Trim());
        else
        {
            Assert.Contains("Installed 1 skill(s).", output);
            Assert.Contains("csharp-xunit", output);
            Assert.DoesNotContain("full-stable-skill-id", output);
        }

        void CheckSelection(JsonElement body, bool install)
        {
            Assert.Equal(source.repository, body.GetProperty("source").GetProperty("repository").GetString());
            Assert.Equal(source.@ref, body.GetProperty("source").GetProperty("ref").GetString());
            Assert.Equal(source.path, body.GetProperty("source").GetProperty("path").GetString());
            Assert.Equal(new[] { "csharp-xunit", "second" }, body.GetProperty("names").EnumerateArray().Select(s => s.GetString()));
            if (install) Assert.Equal("observed-commit", body.GetProperty("commit").GetString());
        }
    }

    [Fact]
    public async Task Add_UsesRootAndHeadDefaultsAndDoesNotInstallAfterDiscoveryFailure()
    {
        var (exitCode, output) = await RunWithCoreAsync(["add", "https://example.test/skills", "--skill", "missing"],
        [new("POST", "/skills/discover", "{\"code\":\"skill_not_found\",\"message\":\"No matching skill: missing.\"}", 404, body =>
        {
            Assert.Equal("HEAD", body.GetProperty("source").GetProperty("ref").GetString());
            Assert.Equal("", body.GetProperty("source").GetProperty("path").GetString());
        })]);
        Assert.Equal(1, exitCode);
        Assert.Contains("skill_not_found", output);
        Assert.DoesNotContain("Installed", output);
    }

    [Fact]
    public async Task Add_MovedSourceIsReportedWithoutSuccessOutput()
    {
        var discovery = "{\"repository\":\"https://example.test/skills\",\"ref\":\"HEAD\",\"commit\":\"first\",\"skills\":[]}";
        var (exitCode, output) = await RunWithCoreAsync(["add", "https://example.test/skills", "--skill", "guide", "--format", "json"],
        [new("POST", "/skills/discover", discovery), new("POST", "/skills/install", "{\"code\":\"skill_source_changed\",\"message\":\"Run skills add again.\"}", 409)]);
        Assert.Equal(1, exitCode);
        Assert.Contains("skill_source_changed", output);
        Assert.DoesNotContain("Installed", output);
    }

    [Theory]
    [InlineData()]
    [InlineData("https://example.test/skills")]
    [InlineData("file:///repo", "--skill", "guide")]
    [InlineData("https://user:secret@example.test/skills", "--skill", "guide")]
    [InlineData("https://example.test/skills", "--skill")]
    [InlineData("https://example.test/skills", "--skill", "--ref", "main")]
    [InlineData("https://example.test/skills", "--skill", "guide", "--format", "xml")]
    [InlineData("https://example.test/skills", "--skill", "guide", "--connection", "private")]
    public async Task Add_InvalidArgumentsFailBeforeConnecting(params string[] args)
    {
        var (console, output) = CreateConsole();
        Assert.Equal(2, await CommandLine.RunAsync(["--data-root", root, "skills", "add", .. args], console));
        Assert.DoesNotContain("Run hosty core start", output.ToString());
        Assert.DoesNotContain("user:secret", output.ToString());
    }

    [Fact]
    public async Task Add_ValidArgumentsRequireRunningCore()
    {
        var (console, output) = CreateConsole();
        Assert.Equal(1, await CommandLine.RunAsync(["--data-root", root, "skills", "add", "https://example.test/repo", "--skill", "guide"], console));
        Assert.Contains("hosty core start", output.ToString());
    }

    private sealed record Reply(string Method, string Path, string Body, int Status = 200, Action<JsonElement>? AssertBody = null);

    private async Task<(int ExitCode, string Output)> RunWithCoreAsync(string[] args, Reply[] replies)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var runDirectory = Path.Combine(root, "core", "run");
        Directory.CreateDirectory(runDirectory);
        await File.WriteAllTextAsync(Path.Combine(runDirectory, "control.json"), JsonSerializer.Serialize(new
        {
            controlBaseUrl = $"http://127.0.0.1:{port}/control/v1",
            requiredHeaders = new Dictionary<string, string> { ["X-Hosty-Test-Control"] = "test-secret" },
        }));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var response = RespondAsync();
        var (console, output) = CreateConsole();
        var exitCode = await CommandLine.RunAsync(["--data-root", root, "skills", .. args], console);
        await response;
        return (exitCode, output.ToString());

        async Task RespondAsync()
        {
            foreach (var reply in replies)
            {
                using var client = await listener.AcceptTcpClientAsync(timeout.Token);
                await using var stream = client.GetStream();
                using var reader = new StreamReader(stream, leaveOpen: true);
                Assert.Equal($"{reply.Method} /control/v1{reply.Path} HTTP/1.1", await reader.ReadLineAsync(timeout.Token));
                var headers = new List<string>();
                while (await reader.ReadLineAsync(timeout.Token) is { Length: > 0 } line) headers.Add(line);
                Assert.Contains("X-Hosty-Test-Control: test-secret", headers);
                var contentLength = headers.FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
                if (contentLength is not null)
                {
                    var length = int.Parse(contentLength.Split(':')[1]);
                    var content = new char[length];
                    Assert.Equal(length, await reader.ReadBlockAsync(content.AsMemory(), timeout.Token));
                    using var body = JsonDocument.Parse(new string(content));
                    reply.AssertBody?.Invoke(body.RootElement);
                }
                var payload = Encoding.UTF8.GetBytes(reply.Body);
                var header = Encoding.ASCII.GetBytes($"HTTP/1.1 {reply.Status} Response\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(header, timeout.Token);
                await stream.WriteAsync(payload, timeout.Token);
            }
            listener.Stop();
        }
    }

    private static (IAnsiConsole Console, StringWriter Output) CreateConsole()
    {
        var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
            Ansi = AnsiSupport.No,
            ColorSystem = ColorSystemSupport.NoColors,
        });
        // CI profile enrichment can override factory settings; keep assertions on plain text.
        console.Profile.Capabilities.Ansi = false;
        console.Profile.Width = 100;
        return (console, output);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
