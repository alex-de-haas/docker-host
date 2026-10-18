using Haas.Hosty.Core;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class PreviewChecksTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-checks-" + Guid.NewGuid().ToString("N"));
    public PreviewChecksTests() => Directory.CreateDirectory(root);
    public void Dispose() => Directory.Delete(root, true);
    [Theory]
    [InlineData("../outside", 20)]
    [InlineData("/tmp", 20)]
    [InlineData(".", 0)]
    [InlineData(".", 301)]
    public void Recipes_RejectEscapesAndUnboundedCommands(string cwd, int timeout)
        => Assert.Throws<AppLifecycleException>(() => PreviewChecks.Validate(new("test", ["npm", "test"], cwd, timeout)));
    [Fact]
    public void Recipes_RejectNullFieldsAndEmptyCommand()
    {
        Assert.Throws<AppLifecycleException>(() => PreviewChecks.Validate(new(null!, ["node"])));
        Assert.Throws<AppLifecycleException>(() => PreviewChecks.Validate(new("test", [])));
        Assert.Throws<AppLifecycleException>(() => PreviewChecks.Validate(new("test", ["node"], null!)));
    }
    [Fact]
    public async Task Revision_DetectsSourceAndRecipeChangesButNotDeclaredGeneratedOutputs()
    {
        Directory.CreateDirectory(Path.Combine(root, "node_modules"));
        await File.WriteAllTextAsync(Path.Combine(root, "source.js"), "version 1");
        var mount = new RuntimeSourceMountManifest { Caches = ["node_modules"] };
        var first = await PreviewChecks.SourceDigest(root, mount, default);
        await File.WriteAllTextAsync(Path.Combine(root, "node_modules/output"), "compiled");
        Assert.Equal(first, await PreviewChecks.SourceDigest(root, mount, default));
        await File.WriteAllTextAsync(Path.Combine(root, "source.js"), "version 2");
        Assert.NotEqual(first, await PreviewChecks.SourceDigest(root, mount, default));
        var edited = await PreviewChecks.SourceDigest(root, mount, default);
        Directory.CreateDirectory(Path.Combine(root, ".hosty"));
        await File.WriteAllTextAsync(Path.Combine(root, ".hosty/preview-checks.json"), "[]");
        Assert.NotEqual(edited, await PreviewChecks.SourceDigest(root, mount, default));
        File.CreateSymbolicLink(Path.Combine(root, "link"), Path.Combine(root, "source.js"));
        await Assert.ThrowsAsync<AppLifecycleException>(() => PreviewChecks.SourceDigest(root, mount, default));
    }
    [Theory]
    [InlineData("foreign", "app", "web", true)]
    [InlineData("instance", "foreign", "web", true)]
    [InlineData("instance", "app", "foreign", true)]
    [InlineData("instance", "app", "web", false)]
    public async Task Container_RejectsOtherOwnersAndStoppedServices(string instance, string app, string service, bool running)
    {
        var runner = new Runner(_ => new(0, JsonSerializer.Serialize(new { Id = new string('a', 64), Image = "image",
            State = new { Running = running }, Config = new { Labels = new Dictionary<string,string> {
                ["hosty.instance"] = instance, ["hosty.app.id"] = app, ["hosty.app.service"] = service } } }), ""));
        await Assert.ThrowsAsync<AppLifecycleException>(() => new PreviewChecks(runner).Container("instance", "app", "web", default));
        Assert.Single(runner.Calls);
    }
    [Theory]
    [InlineData(0, "passed")]
    [InlineData(2, "failed")]
    public async Task Execution_ReturnsRealExitAndBoundedOutputWithoutShellInterpolation(int exit, string state)
    {
        var runner = new Runner(_ => new(exit, new string('x', 20000), "stderr"));
        var result = await new PreviewChecks(runner).Run("owned-id", "/workspace", new("unit", ["node", "literal;argument"]),
            new("web/unit", "digest", Guid.NewGuid().ToString()), default);
        Assert.Equal(state, result.State); Assert.Equal(exit, result.ExitCode);
        Assert.Equal(PreviewChecks.OutputLimit, result.Output!.Length);
        Assert.Equal(new[] { "exec", "--workdir", "/workspace", "owned-id", "node", "literal;argument" }, runner.Calls.Single());
    }
    [Theory]
    [InlineData("false", "timed_out")]
    [InlineData("true", "unknown")]
    public async Task Timeout_StopsExactContainerAndRequiresObservedTermination(string running, string state)
    {
        var runner = new Runner(args => args[0] == "exec" ? throw new OperationCanceledException() : new(0, args[0] == "inspect" ? running : "", ""));
        var result = await new PreviewChecks(runner).Run("owned-id", "/workspace", new("unit", ["node", "test.js"]),
            new("web/unit", "digest", Guid.NewGuid().ToString()), default);
        Assert.Equal(state, result.State); Assert.Null(result.ExitCode);
        Assert.Equal(new[] { "kill", "owned-id" }, runner.Calls[1]);
        Assert.Equal("owned-id", runner.Calls[2].Last());
    }
    [Theory]
    [InlineData(false, "interrupted")]
    [InlineData(true, "unknown")]
    public async Task DockerLoss_IsNotReportedAsATimeoutAndRetainsUnknownTermination(bool cleanupFails, string expected)
    {
        var runner = new Runner(args => args[0] == "exec" || cleanupFails
            ? throw new DockerUnavailableException("Docker unavailable")
            : new(0, args[0] == "inspect" ? "false" : "", ""));
        var result = await new PreviewChecks(runner).Run("owned-id", "/workspace", new("unit", ["node", "test.js"]),
            new("web/unit", "digest", Guid.NewGuid().ToString()), default);
        Assert.Equal(expected, result.State);
        Assert.Null(result.ExitCode);
        Assert.Contains(runner.Calls, args => args.SequenceEqual(new[] { "kill", "owned-id" }));
    }
    private sealed class Runner(Func<IReadOnlyList<string>, DockerCommandResult> action) : IDockerCommandRunner
    {
        public List<IReadOnlyList<string>> Calls { get; } = [];
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        { Calls.Add(args.ToArray()); return Task.FromResult(action(args)); }
    }
}
