namespace Haas.Hosty.Core.Tests;

// Placed UI surfaces (docs/features/app-ui-surfaces/plan.md): what an app declares, and what a
// client is handed. Shell renders a Settings tab or a panel tab for precisely the apps that asked
// for one, so the contract between "declared" and "projected" is the thing under test.
public class AppUiSurfaceContractTests
{
    [Fact]
    public void AnAppDeclaringNeitherSurfaceProjectsNeither()
    {
        // The common case, and the one that must not regress: every app that existed before this
        // feature declares no surface and must keep behaving exactly as it did.
        var ui = AppUiContract.FromManifest(new RuntimeAppUiManifest { Path = "/" });

        Assert.NotNull(ui);
        Assert.Null(ui.Settings);
        Assert.Null(ui.Panel);
    }

    [Fact]
    public void ASurfaceInheritsTheEntrypointEndpointWhenItNamesNone()
    {
        // An app serving everything from one endpoint says so once. Same first-non-blank rule
        // navigation items follow, so the two cannot drift apart.
        var ui = AppUiContract.FromManifest(new RuntimeAppUiManifest
        {
            PortKey = "http",
            Path = "/",
            Settings = new RuntimeAppUiSurfaceManifest { Path = "/settings" },
        });

        Assert.Equal("http", ui!.Settings!.EndpointKey);
        Assert.Equal("/settings", ui.Settings.Path);
    }

    [Fact]
    public void ASurfaceKeepsItsOwnEndpointOverTheEntrypointOne()
    {
        var ui = AppUiContract.FromManifest(new RuntimeAppUiManifest
        {
            PortKey = "http",
            Panel = new RuntimeAppUiSurfaceManifest { Endpoint = "panel", Path = "/tool", Label = "Notes" },
        });

        Assert.Equal("panel", ui!.Panel!.EndpointKey);
        Assert.Equal("Notes", ui.Panel.Label);
    }

    [Theory]
    [InlineData(null, "/")]
    [InlineData("", "/")]
    [InlineData("settings", "/settings")]
    [InlineData("/settings", "/settings")]
    public void SurfacePathsAreNormalizedLikeEveryOtherUiPath(string? declared, string expected)
    {
        var ui = AppUiContract.FromManifest(new RuntimeAppUiManifest
        {
            Settings = new RuntimeAppUiSurfaceManifest { Endpoint = "http", Path = declared },
        });

        Assert.Equal(expected, ui!.Settings!.Path);
    }

    [Fact]
    public void DeclaringOneSurfaceSaysNothingAboutTheOther()
    {
        // They are separate fields rather than one `ui.surface` carrying a kind, precisely so that a
        // third kind (widgets are the recorded next axis) is an addition rather than a change to what
        // these two mean.
        var settingsOnly = AppUiContract.FromManifest(new RuntimeAppUiManifest
        {
            Settings = new RuntimeAppUiSurfaceManifest { Endpoint = "http", Path = "/settings" },
        });
        var panelOnly = AppUiContract.FromManifest(new RuntimeAppUiManifest
        {
            Panel = new RuntimeAppUiSurfaceManifest { Endpoint = "http", Path = "/panel", Label = "Tool" },
        });

        Assert.NotNull(settingsOnly!.Settings);
        Assert.Null(settingsOnly.Panel);
        Assert.NotNull(panelOnly!.Panel);
        Assert.Null(panelOnly.Settings);
    }
}
