using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class MountPathPolicyTests
{
    // A data root with a sibling "outside" tree, both under one temp root so cleanup is one delete.
    private sealed record Harness(MountPathPolicy Policy, string DataRoot, string Outside, string TempRoot);

    private static Harness CreateHarness()
    {
        var created = Path.Combine(Path.GetTempPath(), $"hosty-mount-policy-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(created);
        // Resolve the temp base once so the tests are not confounded by a symlinked ancestor of the OS
        // temp dir (on macOS /var is itself a link to /private/var); the only symlinks that matter are
        // the ones each test creates.
        var tempRoot = MountPathPolicy.ResolveRealPath(created);
        var dataRoot = Path.Combine(tempRoot, "data");
        var outside = Path.Combine(tempRoot, "outside");
        Directory.CreateDirectory(dataRoot);
        Directory.CreateDirectory(outside);
        var paths = new CoreDataPaths(
            DataRoot: dataRoot,
            CoreRoot: Path.Combine(dataRoot, "core"),
            AppsRoot: Path.Combine(dataRoot, "apps"),
            BackupsRoot: Path.Combine(dataRoot, "backups"),
            SourcesRoot: Path.Combine(dataRoot, "sources"),
            AuthRoot: Path.Combine(dataRoot, "core", "auth"),
            AuditLogPath: Path.Combine(dataRoot, "core", "audit", "audit.ndjson"));
        return new Harness(new MountPathPolicy(paths), dataRoot, outside, tempRoot);
    }

    [Fact]
    public void ResolveRealPath_LeavesAPlainPathUnchanged()
    {
        var harness = CreateHarness();
        var dir = Path.Combine(harness.Outside, "sub");
        Directory.CreateDirectory(dir);

        Assert.Equal(Path.GetFullPath(dir), MountPathPolicy.ResolveRealPath(dir));
    }

    [Fact]
    public void NormalizeAndValidate_RejectsAPathBehindAnAncestorSymlinkIntoTheDataRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // The exact C-H3 attack: the final component is an ordinary directory, but an ANCESTOR is a
        // symlink into the data root, so a check that only resolved the leaf would wave it through.
        var harness = CreateHarness();
        var secret = Path.Combine(harness.DataRoot, "apps", "victim");
        Directory.CreateDirectory(secret);
        var link = Path.Combine(harness.Outside, "link");
        Directory.CreateSymbolicLink(link, Path.Combine(harness.DataRoot, "apps"));
        var throughLink = Path.Combine(link, "victim");

        var ex = Assert.Throws<AppLifecycleException>(() => harness.Policy.NormalizeAndValidate(throughLink));
        Assert.Equal("app_mount_path_in_data_root", ex.Code);
    }

    [Fact]
    public void NormalizeAndValidate_RejectsALeafSymlinkIntoTheDataRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var harness = CreateHarness();
        var link = Path.Combine(harness.Outside, "leaf");
        Directory.CreateSymbolicLink(link, harness.DataRoot);

        var ex = Assert.Throws<AppLifecycleException>(() => harness.Policy.NormalizeAndValidate(link));
        Assert.Equal("app_mount_path_in_data_root", ex.Code);
    }

    [Fact]
    public void NormalizeAndValidate_AllowsALegitimateSymlinkOutsideTheDataRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // Mounting through a symlink is common on NAS/removable setups; a link that resolves outside
        // the data root and system paths must still be accepted (and stored as the operator's path).
        var harness = CreateHarness();
        var real = Path.Combine(harness.Outside, "real-disk");
        Directory.CreateDirectory(real);
        var link = Path.Combine(harness.Outside, "mnt");
        Directory.CreateSymbolicLink(link, real);

        var stored = harness.Policy.NormalizeAndValidate(link);

        Assert.Equal(Path.GetFullPath(link), stored);
        Assert.Equal(Path.GetFullPath(real), MountPathPolicy.ResolveRealPath(link));
    }

    [Fact]
    public void ResolveRealPath_ResolvesAnAncestorSymlinkToItsRealTarget()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var harness = CreateHarness();
        var real = Path.Combine(harness.Outside, "real");
        Directory.CreateDirectory(Path.Combine(real, "sub"));
        var link = Path.Combine(harness.Outside, "alias");
        Directory.CreateSymbolicLink(link, real);

        Assert.Equal(Path.Combine(Path.GetFullPath(real), "sub"), MountPathPolicy.ResolveRealPath(Path.Combine(link, "sub")));
    }

    [Fact]
    public void ResolveRealPath_FailsClosedOnASymlinkCycle()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var harness = CreateHarness();
        var a = Path.Combine(harness.Outside, "a");
        var b = Path.Combine(harness.Outside, "b");
        Directory.CreateSymbolicLink(a, b);
        Directory.CreateSymbolicLink(b, a);

        var ex = Assert.Throws<AppLifecycleException>(() => MountPathPolicy.ResolveRealPath(a));
        Assert.Equal("app_mount_path_unresolved", ex.Code);
    }

    [Fact]
    public void NormalizeAndValidate_AcceptsANotYetPresentPath()
    {
        // Registration must keep accepting paths on drives that are not attached yet — a non-existent
        // component cannot be a symlink, so it resolves literally without throwing.
        var harness = CreateHarness();
        var absent = Path.Combine(harness.Outside, "not-attached-yet", "data");

        var stored = harness.Policy.NormalizeAndValidate(absent);

        Assert.Equal(Path.GetFullPath(absent), stored);
    }

    [Fact]
    public void ResolveRealPath_CollapsesDotDotBeforeResolving()
    {
        var harness = CreateHarness();
        var dir = Path.Combine(harness.Outside, "x");
        Directory.CreateDirectory(dir);

        Assert.Equal(Path.GetFullPath(dir), MountPathPolicy.ResolveRealPath(Path.Combine(dir, "y", "..")));
    }
}
