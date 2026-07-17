using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppServiceTokenServiceTests
{
    [Fact]
    public void ValidateToken_AcceptsTokenForSameApp()
    {
        var service = CreateService();
        var token = service.CreateToken("com.example.app");

        Assert.True(service.ValidateToken("com.example.app", token));
    }

    [Fact]
    public void ValidateToken_RejectsTokenForDifferentApp()
    {
        var service = CreateService();
        var token = service.CreateToken("com.example.app");

        Assert.False(service.ValidateToken("com.example.other", token));
    }

    [Fact]
    public void ValidateToken_RejectsMalformedToken()
    {
        var service = CreateService();

        Assert.False(service.ValidateToken("com.example.app", "not-a-token"));
    }

    [Fact]
    public void ResolveAppId_ReturnsAppIdForValidToken()
    {
        var service = CreateService();
        var token = service.CreateToken("com.example.app");

        Assert.Equal("com.example.app", service.ResolveAppId(token));
    }

    [Fact]
    public void ResolveAppId_RejectsTokenSignedWithDifferentKey()
    {
        var issuer = CreateService("issuer-secret");
        var validator = CreateService("other-secret");
        var token = issuer.CreateToken("com.example.app");

        Assert.Null(validator.ResolveAppId(token));
    }

    [Fact]
    public void ResolveAppId_RejectsTokenWithTamperedAppId()
    {
        var service = CreateService();
        var parts = service.CreateToken("com.example.app").Split('.');
        var tamperedAppPart = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("com.example.other"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var tampered = $"{parts[0]}.{parts[1]}.{tamperedAppPart}.{parts[3]}";

        Assert.Null(service.ResolveAppId(tampered));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-token")]
    [InlineData("hosty_app_service.1.only-three-parts")]
    [InlineData("hosty_app_service.1.!!!.signature")]
    public void ResolveAppId_RejectsMalformedTokens(string token)
    {
        var service = CreateService();

        Assert.Null(service.ResolveAppId(token));
    }

    [Fact]
    public void SigningKey_TokenMintedByOneInstance_ValidatesInNewInstanceOverSameDataRoot()
    {
        // The keep-apps light restart regression: an adopted container carries a token minted by the
        // previous Core process, so a fresh service over the same data root must still validate it.
        using var root = new TempRoot();
        var issuer = new AppServiceTokenService(AppServiceSigningKey.LoadOrCreate(root.Paths));
        var token = issuer.CreateToken("com.example.app");

        var validator = new AppServiceTokenService(AppServiceSigningKey.LoadOrCreate(root.Paths));

        Assert.True(validator.ValidateToken("com.example.app", token));
        Assert.Equal("com.example.app", validator.ResolveAppId(token));
    }

    [Fact]
    public void SigningKey_DifferentDataRoots_ProduceDistinctKeys()
    {
        using var rootA = new TempRoot();
        using var rootB = new TempRoot();
        var issuer = new AppServiceTokenService(AppServiceSigningKey.LoadOrCreate(rootA.Paths));
        var validator = new AppServiceTokenService(AppServiceSigningKey.LoadOrCreate(rootB.Paths));

        Assert.Null(validator.ResolveAppId(issuer.CreateToken("com.example.app")));
    }

    [Fact]
    public void SigningKey_PoisonedEmptyKeyFile_IsReplacedWithFreshKey()
    {
        // An empty key file (e.g. left behind by an older crash) must never be read as a valid empty
        // key — it is replaced atomically, and the replacement stays durable for later loads.
        using var root = new TempRoot();
        Directory.CreateDirectory(root.Paths.AuthRoot);
        var keyPath = Path.Combine(root.Paths.AuthRoot, "app-service-signing.key");
        File.WriteAllText(keyPath, "");

        var first = AppServiceSigningKey.LoadOrCreate(root.Paths);
        var second = AppServiceSigningKey.LoadOrCreate(root.Paths);

        Assert.Equal(32, first.Value.Length);
        Assert.Equal(first.Value, second.Value);
    }

    private static AppServiceTokenService CreateService(string seed = "test-secret")
        => new(new AppServiceSigningKey(System.Text.Encoding.UTF8.GetBytes(seed)));

    private sealed class TempRoot : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), $"hosty-core-app-service-token-tests-{Guid.NewGuid():N}");

        public CoreDataPaths Paths => new(
            DataRoot: _root,
            CoreRoot: Path.Combine(_root, "core"),
            AppsRoot: Path.Combine(_root, "apps"),
            BackupsRoot: Path.Combine(_root, "backups"),
            SourcesRoot: Path.Combine(_root, "sources"),
            AuthRoot: Path.Combine(_root, "core", "auth"),
            AuditLogPath: Path.Combine(_root, "core", "audit", "audit.ndjson"));

        public void Dispose()
        {
            try
            {
                Directory.Delete(_root, recursive: true);
            }
            catch (Exception ex) when (ex is IOException or DirectoryNotFoundException or UnauthorizedAccessException)
            {
                // Best-effort cleanup of the per-test temp root.
            }
        }
    }
}
