using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("merge")]
    [InlineData("complete")]
    public async Task Publication_LinkedMetadataPathDoesNotRelaxBranchGuardForMergeOrCompletion(string kind)
    {
        var f = await PublicationFixture();
        var head = f.W.Observation!.Head;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.ExpectedBranch = "hosty/session/another-task";
        f.Provider.State = "merged";
        f.Provider.Complete = true;

        var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, kind,
            new(Guid.NewGuid().ToString(), head, Outcome: "merged", Cleanup: true), default));

        Assert.Equal("publication_pr_mismatch", error.Code);
        Assert.Equal(0, f.Provider.Merged);
        Assert.True(Directory.Exists(f.W.Path));
        Assert.Null(Assert.Single((await f.Service.ListAsync(null, default)).Publications).CompletedAt);
    }
}
