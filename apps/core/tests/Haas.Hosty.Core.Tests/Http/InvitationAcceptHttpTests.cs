using System.Net;
using System.Text;

namespace Haas.Hosty.Core.Tests.Http;

// Invitation accept is public by design — the setup token IS the credential — so every malformed body
// an unauthenticated caller can send has to land on the normal error contract. A missing token used to
// reach the SHA-256 hash and throw ArgumentNullException (HTTP 500); the A4 enumeration sweep hit it
// with its empty-object body. An unknown token and an absent one are the same answer to the caller:
// there is nothing to distinguish for someone who holds neither.
public sealed class InvitationAcceptHttpTests
{
    [Theory]
    [InlineData("{}")]
    [InlineData("""{"setupToken":null}""")]
    [InlineData("""{"setupToken":""}""")]
    [InlineData("""{"setupToken":"   "}""")]
    [InlineData("""{"setupToken":"dhstp_definitely-not-a-real-token"}""")]
    public async Task Post_AnswersInvitationInvalid_ForAMissingOrUnknownToken(string body)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/api/auth/invitations/accept", content);
        var payload = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("invitation_invalid", payload, StringComparison.Ordinal);
    }

    // The preview sibling reads the token from the query string, where "absent" and "blank" are both
    // reachable without a body at all.
    [Theory]
    [InlineData("")]
    [InlineData("%20")]
    [InlineData("dhstp_definitely-not-a-real-token")]
    public async Task Get_AnswersInvitationInvalid_ForABlankOrUnknownToken(string token)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var response = await client.GetAsync($"/api/auth/invitations/accept?setupToken={token}");
        var payload = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("invitation_invalid", payload, StringComparison.Ordinal);
    }
}
