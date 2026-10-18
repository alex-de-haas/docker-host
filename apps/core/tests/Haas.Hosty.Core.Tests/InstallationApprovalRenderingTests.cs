using System.Net;

namespace Haas.Hosty.Core.Tests;

public sealed class InstallationApprovalRenderingTests
{
    [Theory]
    [InlineData("image:api:ghcr.io/example/plans:0.3.0->ghcr.io/example/plans:0.4.1")]
    [InlineData("image:api:registry:5000/plans:old->registry:5000/plans:new")]
    [InlineData("image:api:ghcr.io/example/plans@sha256:aaa->ghcr.io/example/plans@sha256:bbb")]
    [InlineData("image:api:ghcr.io/example/plans:old@sha256:aaa->ghcr.io/example/plans:new@sha256:bbb")]
    [InlineData("artifact:api:sha256:aaa->sha256:bbb")]
    [InlineData("artifact:api:none->sha256:bbb")]
    public void Render_RoutineImageChanges_OmitsNoiseAndPreservesPermissionsAndPlan(string change)
    {
        var plan = Plan(["version:0.3.0->0.4.1", change, "Optional permission added: providers.assistant"]) with
        {
            TargetOptionalCorePermissions = [CoreAppPermissions.AssistantProviders],
        };
        var originalPlan = CoreJson.Text(plan);

        var html = Render(plan);

        Assert.Contains("0.3.0 → 0.4.1", html);
        Assert.Contains("Optional permissions", html);
        Assert.Contains("providers.assistant", html);
        Assert.Contains("(new declaration)", html);
        Assert.DoesNotContain("Other changes", html);
        Assert.DoesNotContain(WebUtility.HtmlEncode(change), html);
        Assert.DoesNotContain("sha256:", html);
        Assert.Equal(originalPlan, CoreJson.Text(plan));
    }

    [Theory]
    [InlineData("image:api:ghcr.io/old/plans:1->ghcr.io/new/plans:2", "Image source for api changed: ghcr.io/old/plans → ghcr.io/new/plans")]
    [InlineData("image:api:old.test/plans@sha256:aaa->new.test/plans@sha256:bbb", "Image source for api changed: old.test/plans → new.test/plans")]
    [InlineData("image:api:registry:5000/plans:1->registry:6000/plans:2", "Image source for api changed: registry:5000/plans → registry:6000/plans")]
    [InlineData("image:api:none->ghcr.io/example/plans:2", "Image source for api added: ghcr.io/example/plans")]
    [InlineData("image:api:ghcr.io/example/plans:1->none", "Image source for api removed: ghcr.io/example/plans")]
    [InlineData("artifact:api:sha256:aaa->unknown", "Image for api could not be verified")]
    public void Render_MeaningfulImageChanges_ShowsReadableSourceOrVerificationWarning(string change, string description)
    {
        var html = Render(Plan([change]));

        Assert.Contains("Other changes", html);
        Assert.Contains(WebUtility.HtmlEncode(description), html);
        Assert.DoesNotContain(WebUtility.HtmlEncode(change), html);
        Assert.DoesNotContain("sha256:", html);
    }

    [Theory]
    [InlineData("image:api:->")]
    [InlineData("image:api:missing-target")]
    [InlineData("artifact:api:missing-target")]
    [InlineData("future-change:<script>bad()</script>")]
    public void Render_UnrecognizedChange_KeepsEscapedDetails(string change)
    {
        var html = Render(Plan([change]));

        Assert.Contains(WebUtility.HtmlEncode(change), html);
        Assert.DoesNotContain("<script>", html);
    }

    [Fact]
    public void Render_ImageSourceChange_EscapesPublisherText()
    {
        var html = Render(Plan(["image:<script>service</script>:old.test/plans:1->new.test/<script>image</script>:2"]));

        Assert.Contains("Image source for &lt;script&gt;service&lt;/script&gt; changed:", html);
        Assert.Contains("new.test/&lt;script&gt;image&lt;/script&gt;", html);
        Assert.DoesNotContain("<script>", html);
    }

    [Theory]
    [InlineData("docker", "docker", "docker", "docker")]
    [InlineData("stable", "stable", "docker", "stable · docker")]
    [InlineData("dev", "docker", "docker", "dev → docker")]
    [InlineData("docker", "dev", "localCommand", "docker → dev · localCommand")]
    [InlineData("docker", "docker", null, "docker")]
    public void Render_RuntimeMetadata_ShowsChangesWithoutDuplicateValues(string current, string target, string? type, string expected)
    {
        var html = Render(Plan([]) with { CurrentRuntime = current, TargetRuntime = target, TargetRuntimeType = type });

        Assert.Contains($"<dt>Runtime</dt><dd>{expected}</dd>", html);
    }

    private static AppUpdatePlan Plan(IReadOnlyList<string> changes) => new("app", "0.3.0", "0.4.1", "docker", "docker",
        "https://example.test/manifest.json", "manifest-digest", "plan-digest", false, changes)
    {
        TargetRuntimeType = "docker", PreviousRequiredCorePermissions = [], PreviousOptionalCorePermissions = [],
    };

    private static string Render(AppUpdatePlan plan) => InstallationApprovalEndpoints.Render(new InstallationApproval
    {
        UserId = "admin", CallerName = "Hosty Shell", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
        UpdatePlan = plan, Status = "pending",
    }, "nonce");
}
