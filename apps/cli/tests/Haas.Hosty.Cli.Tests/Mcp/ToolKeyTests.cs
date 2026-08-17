namespace Haas.Hosty.Cli.Tests.Mcp;

using Haas.Hosty.Cli.Mcp;

// The mapping settled in docs/features/hosty-mcp-connector/feature.md. "Collision-free" is a claim, so
// the cases that would break it are asserted rather than reasoned about — and each refusal is
// asserted beside the name that must still come through, since a mapping that refused everything
// would satisfy the negatives alone.
public class ToolKeyTests
{
    [Fact]
    public void DefaultInterfaceIsLeftOutOfTheName()
    {
        // Nearly every app declares only `default`, and every character the connector spends is one
        // the app's own tool names cannot have.
        Assert.Equal("com_dhaas_ddemo-app", ToolKey.ForInterface("com.haas.demo-app", "default"));
        Assert.Equal("com_dhaas_ddemo-app", ToolKey.ForInterface("com.haas.demo-app", null));
        Assert.Equal("com_dhaas_ddemo-app__admin", ToolKey.ForInterface("com.haas.demo-app", "admin"));
    }

    [Fact]
    public void IdsThatNaivelySanitizeAlikeStayApart()
    {
        // Replacing dots with hyphens maps these onto the same string — a bug already found and fixed
        // once in the AI gateway. Silently merging two apps is the worst failure available here.
        Assert.NotEqual(
            ToolKey.ForInterface("com.example.notes", "default"),
            ToolKey.ForInterface("com-example-notes", "default"));
    }

    [Fact]
    public void UnderscoresInAnIdCannotForgeASegmentBoundary()
    {
        // An id containing `_` must not produce `__`, or it could impersonate the key/interface or
        // key/tool boundary.
        var key = ToolKey.ForInterface("com.example.my_app", "default");

        Assert.DoesNotContain("__", key);
        Assert.NotEqual(ToolKey.ForInterface("com.example.my", "app"), key);
    }

    [Fact]
    public void AToolNameCarryingTheSeparatorIsRefused()
    {
        // The pair rule 5 exists for: without the refusal these two produce the identical string.
        var viaToolName = ToolKey.ForTool(ToolKey.ForInterface("x", "default"), "admin__foo");
        var viaInterface = ToolKey.ForTool(ToolKey.ForInterface("x", "admin"), "foo");

        Assert.Null(viaToolName);
        Assert.Equal("x__admin__foo", viaInterface);
    }

    [Fact]
    public void TheLongestIdCoreAcceptsStillFitsAndStaysDistinct()
    {
        // Core's pattern admits 63 characters, and the escape can nearly double one. Before the length
        // rule, such an app would have had every tool rejected by a client.
        var first = "com.example." + new string('a', 40) + ".notes";
        var second = "com.example." + new string('a', 40) + ".other";
        Assert.Equal(58, first.Length);

        var firstKey = ToolKey.ForInterface(first, "default");
        var secondKey = ToolKey.ForInterface(second, "default");

        Assert.Equal(32, firstKey.Length);
        Assert.Equal(32, secondKey.Length);
        // Differing only past the truncation point is exactly the case the digest carries.
        Assert.NotEqual(firstKey, secondKey);
        Assert.NotNull(ToolKey.ForTool(firstKey, "list_people"));
    }

    [Fact]
    public void ATruncatedKeyDependsOnlyOnItsOwnApp()
    {
        // The property that made hashing-on-collision unacceptable: a name must not change because
        // some unrelated app was installed. Hashing on length is a pure function of the app itself,
        // so the same call twice — and in any fleet — gives the same answer.
        var id = "com.example." + new string('b', 45);

        Assert.Equal(ToolKey.ForInterface(id, "default"), ToolKey.ForInterface(id, "default"));
        Assert.NotEqual(ToolKey.ForInterface(id, "default"), ToolKey.ForInterface(id, "admin"));
    }

    [Fact]
    public void ANameOverTheCeilingIsRefusedRatherThanTruncated()
    {
        // Truncating tool names collides them with each other, which is worse than not offering one.
        var key = ToolKey.ForInterface("com.example.notes", "default");

        Assert.Null(ToolKey.ForTool(key, new string('t', 60)));
        Assert.Equal($"{key}__ok", ToolKey.ForTool(key, "ok"));
    }

    [Fact]
    public void TheEscapeIsInjectiveAcrossItsWholeAlphabet()
    {
        // A sweep rather than a handful of examples: every pair of these must stay distinct, which is
        // what "reversible" buys and what a lossy replacement would break.
        string[] ids =
        [
            "a.b", "a-b", "a_b", "a_db", "a_ub", "ab", "a..b", "a.-b", "a-.b", "a_.b", "a._b",
        ];

        var keys = ids.Select(id => ToolKey.ForInterface(id, "default")).ToArray();

        Assert.Equal(ids.Length, keys.Distinct(StringComparer.Ordinal).Count());
        Assert.All(keys, key => Assert.DoesNotContain("__", key));
    }
}
