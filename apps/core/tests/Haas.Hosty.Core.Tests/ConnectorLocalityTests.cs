using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class ConnectorLocalityTests
{
    [Fact]
    public void Evaluate_SameAddress_IsLocal()
        => Assert.Equal(ConnectorLocality.Local, ConnectorLocality.Evaluate(["2001:db8::1"], ["2001:db8::1"]));

    [Fact]
    public void Evaluate_Ipv6ConnectorVsIpv4Egress_IsUnknownNotFalseMismatch()
    {
        // The spike's connector reported an IPv6 origin_ip. Comparing it against an IPv4-only egress must
        // NOT produce a false "not_local" — the families don't overlap, so the verdict is "unknown".
        Assert.Equal(ConnectorLocality.Unknown, ConnectorLocality.Evaluate(["2001:db8::1"], ["203.0.113.5"]));
    }

    [Fact]
    public void Evaluate_SameFamilyDifferentAddress_IsNotLocal()
        => Assert.Equal(ConnectorLocality.NotLocal, ConnectorLocality.Evaluate(["2001:db8::1"], ["2001:db8::2"]));

    [Fact]
    public void Evaluate_MatchOnAnyFamily_IsLocal()
        => Assert.Equal(ConnectorLocality.Local, ConnectorLocality.Evaluate(["2001:db8::1", "203.0.113.5"], ["203.0.113.5"]));

    [Fact]
    public void Evaluate_NoEgressOrNoConnector_IsUnknown()
    {
        Assert.Equal(ConnectorLocality.Unknown, ConnectorLocality.Evaluate(["2001:db8::1"], []));
        Assert.Equal(ConnectorLocality.Unknown, ConnectorLocality.Evaluate([], ["203.0.113.5"]));
    }

    [Fact]
    public void Evaluate_IgnoresUnparseableAddresses()
        => Assert.Equal(ConnectorLocality.Unknown, ConnectorLocality.Evaluate(["not-an-ip"], ["also-bad"]));
}
