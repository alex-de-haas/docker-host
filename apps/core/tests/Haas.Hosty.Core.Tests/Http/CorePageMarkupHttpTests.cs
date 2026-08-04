namespace Haas.Hosty.Core.Tests.Http;

// Core's own pages are the whole UI of a host with no Shell, and the native client shows `/login` inside
// a sheet barely 520pt wide. Two properties of that markup are worth holding onto, because both failed
// silently: the card used to be laid out in `content-box`, so padding and border were added to a width
// already equal to the viewport and every narrow window scrolled sideways over a clipped form; and the
// identity field carried `autocomplete="email"`, a contact-detail token, where a password manager looks
// for `username` next to `current-password` before it offers a saved login.
public sealed class CorePageMarkupHttpTests
{
    [Theory]
    [InlineData("/login")]
    [InlineData("/setup")]
    [InlineData("/recovery")]
    [InlineData("/setup/invite")]
    public async Task Page_LaysOutItsCardInBorderBox(string url)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var response = await client.GetAsync(url);
        var html = await response.Content.ReadAsStringAsync();

        Assert.Contains("box-sizing: border-box", html, StringComparison.Ordinal);
        Assert.DoesNotContain("calc(100vw - 2rem)", html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LoginPage_MarksTheCredentialPairForPasswordManagers()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var response = await client.GetAsync("/login");
        var html = await response.Content.ReadAsStringAsync();

        Assert.Contains("autocomplete=\"username\"", html, StringComparison.Ordinal);
        Assert.Contains("autocomplete=\"current-password\"", html, StringComparison.Ordinal);
    }

    // The sign-in page states nothing about the deployment. Which Core answered and where its Shell lives
    // are facts for a signed-in operator, not for the one screen anyone on the network can reach.
    [Fact]
    public async Task LoginPage_NamesNoOrigins()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var response = await client.GetAsync("/login");
        var html = await response.Content.ReadAsStringAsync();

        Assert.DoesNotContain("Core origin", html, StringComparison.Ordinal);
        Assert.DoesNotContain("Shell origin", html, StringComparison.Ordinal);
    }
}
