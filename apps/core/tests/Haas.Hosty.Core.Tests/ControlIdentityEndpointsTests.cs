using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class ControlIdentityEndpointsTests
{
    // `hosty apps open <id> --mode shell` prints whatever this builds, and for a long time it built
    // `{shellOrigin}/apps/{appId}` — a path the Shell has never served, since `/apps` is its app
    // overview with no per-app segment beneath it. The command handed the operator a 404. Nothing
    // caught it because no test named the shape, so the shape is named here.
    [Fact]
    public void BuildShellWorkspaceUrl_TargetsTheWorkspaceRoute()
    {
        var url = ControlIdentityEndpoints.BuildShellWorkspaceUrl("https://shell.example", "com.example.notes");

        Assert.Equal("https://shell.example/workspace?app=com.example.notes&path=%2F", url);
    }

    [Fact]
    public void BuildShellWorkspaceUrl_DoesNotDoubleTheOriginSlash()
    {
        var url = ControlIdentityEndpoints.BuildShellWorkspaceUrl("https://shell.example/", "com.example.notes");

        Assert.Equal("https://shell.example/workspace?app=com.example.notes&path=%2F", url);
    }

    [Fact]
    public void BuildShellWorkspaceUrl_EscapesTheAppId()
    {
        var url = ControlIdentityEndpoints.BuildShellWorkspaceUrl("https://shell.example", "com.example/notes and more");

        Assert.Equal("https://shell.example/workspace?app=com.example%2Fnotes%20and%20more&path=%2F", url);
    }
}
