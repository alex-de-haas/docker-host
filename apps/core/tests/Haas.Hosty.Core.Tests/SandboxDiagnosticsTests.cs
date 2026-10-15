namespace Haas.Hosty.Core.Tests;

public class SandboxDiagnosticsTests
{
    [Fact]
    public void RedactionPrecedesTruncationAndStripsControlCodes()
    {
        var text = "hostysb_grant_" + new string('a', 20000) + "\nBearer private-value password=private-value eyJhbGci.xxxxx.yyyyy\u001b";
        var result = SandboxLogText.Sanitize(text);
        Assert.DoesNotContain("private-value", result);
        Assert.DoesNotContain("eyJ", result);
        Assert.DoesNotContain("aaaa", result);
        Assert.DoesNotContain('\u001b', result);
        Assert.Contains("[redacted]", result);
        Assert.True(SandboxLogText.Sanitize(new string('x', 50000)).Length < 16500);
    }
}
