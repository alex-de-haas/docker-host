using System.Net;
using Haas.Hosty.Launch;
using Haas.Hosty.Releases;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CorePlatformFeedServiceTests : IDisposable
{
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-platform-handoff-" + Guid.NewGuid().ToString("N"));
    private readonly AssetClients clients;
    private readonly CoreUpdateCheckService checker;
    private readonly CorePlatformFeedService service;

    public CorePlatformFeedServiceTests()
    {
        Directory.CreateDirectory(root);
        var config = new HostyCoreRuntimeConfig(root, Path.Combine(root, "core", "run"),
            Path.Combine(root, "core", "run", "control.json"), 7070, "http://localhost:7070", null, "localhost", null, false);
        clients = new(root);
        checker = new(clients, config, NullLogger<CoreUpdateCheckService>.Instance);
        service = new(config, clients, checker);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ApplyAsync_InitialOrRetriedRequest_ReleasesLaunchLockBeforeStartingHelper(bool retry)
    {
        var (request, selection) = PrepareRequest(retry);
        var launches = 0;

        var result = await service.ApplyAsync(request, default, () => "test-hosty", (cli, operationId) =>
        {
            launches++;
            Assert.Equal("test-hosty", cli);
            Assert.Equal(request.RequestId, operationId);
            // The helper must acquire the actual exclusive lock before the request returns.
            using var helperLock = CoreLaunchFiles.Lock(root);
            var accepted = Assert.IsType<PlatformUpdateAcceptance>(PlatformAcceptedUpdates.Read(root, operationId));
            Assert.Equal(request.OfferId, accepted.OfferId);
            Assert.Equal(selection.Release.ReleaseId, accepted.Selection.Release.ReleaseId);
            Assert.Equal(selection.Source.Revision, accepted.Selection.Source.Revision);
            Assert.Equal(root, accepted.Root);
            Assert.Equal("accepted", accepted.Status);
            Assert.Contains(operationId, Assert.Throws<InvalidOperationException>(
                () => CoreLaunchFiles.AssertNoPendingOperations(root)).Message);
            CoreLaunchFiles.AssertNoPendingOperations(root, ownPlatformUpdateId: operationId);
        });

        Assert.Equal(1, launches);
        Assert.Equal(request.RequestId, result.Id);
        Assert.Equal("accepted", result.Status);
        Assert.Equal(selection.Release.ReleaseId, result.ReleaseId);
        Assert.Equal(retry ? 0 : 2, clients.RequestCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ApplyAsync_HelperLaunchFails_PreservesFrozenAcceptanceForRecovery(bool retry)
    {
        var (request, selection) = PrepareRequest(retry);

        var error = await Assert.ThrowsAsync<IOException>(() => service.ApplyAsync(request, default, () => "test-hosty", (_, operationId) =>
        {
            using var helperLock = CoreLaunchFiles.Lock(root);
            Assert.Equal(request.RequestId, operationId);
            throw new IOException("helper failed to start");
        }));

        Assert.Equal("helper failed to start", error.Message);
        var accepted = Assert.IsType<PlatformUpdateAcceptance>(PlatformAcceptedUpdates.Read(root, request.RequestId));
        Assert.Equal("helper failed to start", accepted.Error);
        Assert.Equal(request.OfferId, accepted.OfferId);
        Assert.Equal("accepted", accepted.Status);
        Assert.Equal(selection.Release.ReleaseId, accepted.Selection.Release.ReleaseId);
        Assert.Equal(selection.Source.Revision, accepted.Selection.Source.Revision);
        Assert.Contains(request.RequestId, Assert.Throws<InvalidOperationException>(
            () => CoreLaunchFiles.AssertNoPendingOperations(root)).Message);
        using var available = CoreLaunchFiles.Lock(root);
    }

    [Fact]
    public async Task ApplyAsync_HelperCompletesThenSpawnThrows_PreservesCompletedReceipt()
    {
        var (request, _) = PrepareRequest(retry: true);
        string? completedReceipt = null;

        var error = await Assert.ThrowsAsync<IOException>(() => service.ApplyAsync(request, default, () => "test-hosty", (_, id) =>
        {
            using var helperLock = CoreLaunchFiles.Lock(root);
            WriteAcceptance(PlatformAcceptedUpdates.Read(root, id)! with { Status = "completed", Error = null });
            completedReceipt = File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, id));
            throw new IOException("spawn probe failed");
        }));

        Assert.Equal("spawn probe failed", error.Message);
        Assert.Equal(completedReceipt, File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, request.RequestId)));
        Assert.Equal("completed", service.GetOperation(request.RequestId).Status);
    }

    [Fact]
    public async Task ApplyAsync_HelperAdvancesJournalThenSpawnThrows_PreservesHelperProgress()
    {
        var (request, selection) = PrepareRequest(retry: false);
        string? helperReceipt = null;
        string? helperJournal = null;

        var error = await Assert.ThrowsAsync<IOException>(() => service.ApplyAsync(request, default, () => "test-hosty", (_, id) =>
        {
            using var helperLock = CoreLaunchFiles.Lock(root);
            WriteAcceptance(PlatformAcceptedUpdates.Read(root, id)! with { Error = "helper-owned receipt" });
            WriteJournal(id, selection);
            helperReceipt = File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, id));
            helperJournal = File.ReadAllText(PlatformUpdateTransaction.JournalPath(root));
            throw new IOException("spawn probe failed");
        }));

        Assert.Equal("spawn probe failed", error.Message);
        Assert.Equal(helperReceipt, File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, request.RequestId)));
        Assert.Equal(helperJournal, File.ReadAllText(PlatformUpdateTransaction.JournalPath(root)));
        Assert.Equal("preparing", service.GetOperation(request.RequestId).Status);
        Assert.Equal("helper transaction diagnostic", service.GetOperation(request.RequestId).Error);
    }

    [Fact]
    public async Task ApplyAsync_HelperRetainsLockThenSpawnThrows_PreservesOriginalErrorAndHelperProgress()
    {
        var (request, selection) = PrepareRequest(retry: true);
        FileStream? helperLock = null;
        string? helperReceipt = null;
        string? helperJournal = null;
        try
        {
            var error = await Assert.ThrowsAsync<IOException>(() => service.ApplyAsync(request, default, () => "test-hosty", (_, id) =>
            {
                helperLock = CoreLaunchFiles.Lock(root);
                WriteAcceptance(PlatformAcceptedUpdates.Read(root, id)! with { Error = "helper-owned receipt" });
                WriteJournal(id, selection);
                helperReceipt = File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, id));
                helperJournal = File.ReadAllText(PlatformUpdateTransaction.JournalPath(root));
                throw new IOException("spawn probe failed");
            }));

            Assert.Equal("spawn probe failed", error.Message);
            Assert.Equal(helperReceipt, File.ReadAllText(PlatformAcceptedUpdates.PathFor(root, request.RequestId)));
            Assert.Equal(helperJournal, File.ReadAllText(PlatformUpdateTransaction.JournalPath(root)));
            Assert.NotNull(helperLock);
            Assert.Throws<IOException>(() => CoreLaunchFiles.Lock(root));
        }
        finally { helperLock?.Dispose(); }
    }

    [Fact]
    public async Task ApplyAsync_CompletedRequest_ReturnsResultWithoutLaunchingHelper()
    {
        var (request, selection) = PrepareRequest(retry: true);
        var accepted = PlatformAcceptedUpdates.Read(root, request.RequestId)!;
        WriteAcceptance(accepted with { Status = "completed" });

        var result = await service.ApplyAsync(request, default,
            () => throw new InvalidOperationException("Completed requests must not resolve the CLI."),
            (_, _) => throw new InvalidOperationException("Completed requests must not launch a helper."));

        Assert.Equal("completed", result.Status);
        Assert.Equal(selection.Release.ReleaseId, result.ReleaseId);
        Assert.Equal(0, clients.RequestCount);
    }

    [Fact]
    public async Task ApplyAsync_ReplayedRequestNamesDifferentOffer_RejectsBeforeLaunchingHelper()
    {
        var (request, _) = PrepareRequest(retry: true);

        var error = await Assert.ThrowsAsync<PlatformReleaseException>(() => service.ApplyAsync(
            request with { OfferId = Guid.NewGuid().ToString("N") }, default,
            () => throw new InvalidOperationException("Conflicting requests must not resolve the CLI."),
            (_, _) => throw new InvalidOperationException("Conflicting requests must not launch a helper.")));

        Assert.Equal("platform_update_replay_conflict", error.Code);
        Assert.Equal(request.OfferId, PlatformAcceptedUpdates.Read(root, request.RequestId)!.OfferId);
        Assert.Equal(0, clients.RequestCount);
    }

    private (CorePlatformUpdateRequest Request, PlatformReleaseSelection Selection) PrepareRequest(bool retry)
    {
        var source = new PlatformUpdateSource("hosty-platform-update-source.0.1", "https://publisher.test/feeds.json", "candidate", "frozen-revision");
        var assets = new[] { "cli", "core" }.Select(role => new PlatformReleaseAsset(role, PlatformFeedSource.CurrentRid,
            role, "https://publisher.test/" + role, 3, Hash, Hash, "https://publisher.test/provenance")).ToArray();
        var selection = new PlatformReleaseSelection(source,
            new("candidate", "https://publisher.test/release.json", Hash),
            new("hosty-platform-release.0.1", Hash, "1.0.0", new string('a', 40), assets), Hash, Hash);
        var request = new CorePlatformUpdateRequest(Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"));
        if (retry)
        {
            // A retry uses its durable selection even after the original offer and source disappear.
            WriteAcceptance(new(request.RequestId, request.OfferId, root, selection, DateTimeOffset.UtcNow.AddDays(-1),
                Error: "previous helper failed"));
        }
        else
        {
            CoreLaunchFiles.Write(PlatformFeedFiles.SourcePath(root), source, PlatformReleaseJson.Default.PlatformUpdateSource);
            var offer = new CorePlatformOffer(request.OfferId, selection, DateTimeOffset.UtcNow);
            CoreLaunchFiles.Write(checker.OfferPath(request.OfferId), offer, CoreJson.TypeInfo<CorePlatformOffer>());
        }
        return (request, selection);
    }

    private void WriteJournal(string id, PlatformReleaseSelection selection) => CoreLaunchFiles.Write(
        PlatformUpdateTransaction.JournalPath(root),
        new PlatformUpdateOperation("hosty-platform-update.0.1", id, root, selection, PlatformFeedSource.CurrentRid,
            "preparing", null, [], DateTimeOffset.UtcNow, Error: "helper transaction diagnostic"),
        PlatformUpdateJson.Default.PlatformUpdateOperation);

    private void WriteAcceptance(PlatformUpdateAcceptance acceptance) => CoreLaunchFiles.Write(
        PlatformAcceptedUpdates.PathFor(root, acceptance.Id), acceptance, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);

    private sealed class AssetClients(string root) : HttpMessageHandler, IHttpClientFactory
    {
        public int RequestCount { get; private set; }
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(HttpMethod.Head, request.Method);
            Assert.Throws<IOException>(() => CoreLaunchFiles.Lock(root));
            RequestCount++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[3]) });
        }
    }

    public void Dispose()
    {
        clients.Dispose();
        Directory.Delete(root, recursive: true);
    }
}
