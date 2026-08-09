using System.Security.Cryptography;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DelegatedTokenServiceTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 8, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void CreateToken_RoundTripsThroughValidate()
    {
        var service = CreateService(out _, out _);

        var issued = service.CreateToken("com.example.gateway", "user_1", "host.admin");
        var claims = service.ValidateToken(issued.Token, "com.example.gateway");

        Assert.NotNull(claims);
        Assert.Equal("user_1", claims.Sub);
        Assert.Equal("host.admin", claims.Role);
        Assert.Equal("com.example.gateway", claims.Aud);
        Assert.Equal(Now.Add(DelegatedTokenService.TokenLifetime), issued.ExpiresAt);
        Assert.StartsWith("hosty_delegated.1.", issued.Token, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateToken_RejectsWrongAudience()
    {
        var service = CreateService(out _, out _);

        var issued = service.CreateToken("com.example.gateway", "user_1", "host.admin");

        Assert.Null(service.ValidateToken(issued.Token, "com.example.other"));
    }

    [Fact]
    public void ValidateToken_RejectsExpiredToken()
    {
        var service = CreateService(out _, out var clock);

        var issued = service.CreateToken("com.example.gateway", "user_1", "host.admin");
        clock.UtcNow = Now.Add(DelegatedTokenService.TokenLifetime).AddSeconds(1);

        Assert.Null(service.ValidateToken(issued.Token, "com.example.gateway"));
    }

    [Fact]
    public void ValidateToken_RejectsTamperedPayload()
    {
        var service = CreateService(out _, out _);

        var issued = service.CreateToken("com.example.gateway", "user_1", "host.member");
        // Swap the signed payload for one claiming a different role; the signature no longer matches.
        var forgedPayload = Convert.ToBase64String("""{"sub":"user_1","role":"host.admin","aud":"com.example.gateway","iat":0,"exp":9999999999,"jti":"x"}"""u8.ToArray())
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var parts = issued.Token.Split('.');
        var forged = $"{parts[0]}.{parts[1]}.{forgedPayload}.{parts[3]}";

        Assert.Null(service.ValidateToken(forged, "com.example.gateway"));
    }

    [Fact]
    public void ValidateToken_RejectsTokenSignedWithForeignKey()
    {
        var service = CreateService(out _, out _);
        var foreignService = CreateService(out _, out _);

        var issued = foreignService.CreateToken("com.example.gateway", "user_1", "host.admin");

        Assert.Null(service.ValidateToken(issued.Token, "com.example.gateway"));
    }

    [Fact]
    public void LoadOrCreate_IsDurableAcrossReloads()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-delegated-key-tests-{Guid.NewGuid():N}");
        try
        {
            var paths = CreatePaths(root);

            var first = DelegatedTokenSigningKey.LoadOrCreate(paths);
            var second = DelegatedTokenSigningKey.LoadOrCreate(paths);

            // The public key baked into app environments must survive a Core restart, or every
            // still-running app would hold a stale verification key after a keep-apps restart.
            Assert.Equal(first.PublicKeySpkiBase64, second.PublicKeySpkiBase64);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void PublicKey_VerifiesTokenSignatureAsSpki()
    {
        // The SDK-side contract: the injected value imports as SPKI and verifies the signature over
        // the token prefix with ECDSA P-256 / SHA-256 in IEEE P1363 format.
        var service = CreateService(out var key, out _);
        var issued = service.CreateToken("com.example.gateway", "user_1", "host.admin");
        var parts = issued.Token.Split('.');
        var signingInput = $"{parts[0]}.{parts[1]}.{parts[2]}";
        var signaturePadded = parts[3].Replace('-', '+').Replace('_', '/');
        signaturePadded = signaturePadded.PadRight(signaturePadded.Length + (4 - signaturePadded.Length % 4) % 4, '=');

        using var ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(key.PublicKeySpkiBase64), out _);

        Assert.True(ecdsa.VerifyData(
            System.Text.Encoding.UTF8.GetBytes(signingInput),
            Convert.FromBase64String(signaturePadded),
            HashAlgorithmName.SHA256));
    }

    private static DelegatedTokenService CreateService(out DelegatedTokenSigningKey key, out FakeClock clock)
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        key = new DelegatedTokenSigningKey(ecdsa.ExportPkcs8PrivateKey());
        clock = new FakeClock(Now);
        return new DelegatedTokenService(key, clock);
    }

    private static CoreDataPaths CreatePaths(string root)
        => new(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
