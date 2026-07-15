using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Haas.Hosty.Core;

// AOT-safe JSON result helper for Minimal API endpoints. Resolves the source-generated
// JsonTypeInfo<T> from the context and uses the non-reflection Results.Json overload, so
// endpoint responses carry no IL2026/IL3050 warnings. Works for both concrete and generic
// T (the wrapper helpers serialize a generic service-result type).
internal static class CoreJson
{
    public static JsonTypeInfo<T> TypeInfo<T>()
        => CoreJsonSerializerContext.Default.Options.GetTypeInfo(typeof(T)) as JsonTypeInfo<T>
            ?? throw new NotSupportedException(
                $"Type '{typeof(T).FullName}' is not registered in {nameof(CoreJsonSerializerContext)}.");

    public static IResult Json<T>(T value, int? statusCode = null)
        => Results.Json(value, TypeInfo<T>(), statusCode: statusCode);
}

// Source-generated JSON metadata for Native AOT compatibility.
//
// Every type serialized or deserialized at runtime must be reachable from one of
// the [JsonSerializable] roots below. The generator pulls in nested/referenced
// types automatically, so only the top-level roots are listed here:
//   * HTTP request bodies bound by Minimal API endpoints,
//   * objects passed to Results.Json(...),
//   * the generic T of JsonStorage / JsonSerializer storage round-trips and digests.
//
// JsonSerializerDefaults.Web matches every JsonSerializerOptions instance in Core
// (camelCase, case-insensitive). WriteIndented is a runtime formatting flag applied
// by each options object, so the same context serves both indented and compact callers.
// One-click Cloudflare ingress (phase 1): API response envelopes, the at-rest credential, and its masked
// summary projection.
[JsonSerializable(typeof(CloudflareErrorResponse))]
[JsonSerializable(typeof(CloudflareAccountsResponse))]
[JsonSerializable(typeof(CloudflareZonesResponse))]
[JsonSerializable(typeof(CloudflareTunnelsResponse))]
[JsonSerializable(typeof(CloudflareConnectionsResponse))]
[JsonSerializable(typeof(CloudflareTokenVerifyResponse))]
[JsonSerializable(typeof(CloudflareCredential))]
[JsonSerializable(typeof(CloudflareCredentialSummary))]
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]

// Persisted state / internal serialization roots.
[JsonSerializable(typeof(UserDirectoryState))]
[JsonSerializable(typeof(AppStateDocument))]
[JsonSerializable(typeof(GlobalMountState))]
// Reachable via AppRecord/AppSummary, but rooted explicitly: the per-service artifact run-lock is
// (de)serialized as a nested map value on persisted state and on API summaries.
[JsonSerializable(typeof(ArtifactLock))]
// Reachable via AppRecord, but rooted explicitly (same reason as ArtifactLock): a nested map value on
// persisted state carrying the Development-Mode enable snapshot bookkeeping.
[JsonSerializable(typeof(DevelopmentModeBaseline))]
[JsonSerializable(typeof(RetainedAppConfig))]
// Durable localCommand pidfile ({AppRoot}/run/{serviceKey}.json) the orphan-reclaim reads back to
// find and kill process trees the in-memory registry lost across a non-graceful Core exit.
[JsonSerializable(typeof(LocalCommandPidFile))]
[JsonSerializable(typeof(RuntimeAppManifest))]
[JsonSerializable(typeof(AppFeedsDocument))]
// Generic bootstrap: the release-owned distribution list, the operator's choices file, and the
// host-admin bootstrap endpoint contracts.
[JsonSerializable(typeof(DistributionAppsDocument))]
[JsonSerializable(typeof(BootstrapChoicesDocument))]
[JsonSerializable(typeof(CoreBootstrapChoiceRequest))]
[JsonSerializable(typeof(CoreBootstrapStateResponse))]
// Core-owned behavior settings (auth lifetimes) edited from the Shell platform panel.
[JsonSerializable(typeof(CoreSettingsDocument))]
[JsonSerializable(typeof(CoreSettingsResponse))]
[JsonSerializable(typeof(CoreSettingsUpdateRequest))]
// Core update-available check for the Shell sidebar + the persisted product-channel pointer it reads.
[JsonSerializable(typeof(CoreUpdateStatus))]
[JsonSerializable(typeof(CoreProductChannelRef))]
[JsonSerializable(typeof(AuditRecord))]
[JsonSerializable(typeof(AppAuthCodeState))]
[JsonSerializable(typeof(AppSessionGrantState))]
[JsonSerializable(typeof(AppBackupRecord))]
[JsonSerializable(typeof(AuthBootstrapTokenState))]
[JsonSerializable(typeof(ControlDiscoveryDocument))]
[JsonSerializable(typeof(AppBackupRetentionDigestPayload))]
[JsonSerializable(typeof(AppUpdatePlanDigestSeed))]
[JsonSerializable(typeof(AppRuntimeSwitchDigestSeed))]
[JsonSerializable(typeof(NotificationState))]

// HTTP request bodies.
[JsonSerializable(typeof(AuthSessionCreateRequest))]
[JsonSerializable(typeof(AppAuthorizeRequest))]
[JsonSerializable(typeof(AppTokenExchangeRequest))]
[JsonSerializable(typeof(AppRevalidateRequest))]
[JsonSerializable(typeof(AppLaunchCodeRequest))]
[JsonSerializable(typeof(AuthBootstrapRequest))]
[JsonSerializable(typeof(AuthRecoveryRequest))]
[JsonSerializable(typeof(AppSourceResolveRequest))]
[JsonSerializable(typeof(AppSourceOverrideRequest))]
[JsonSerializable(typeof(AppInstallPlanRequest))]
[JsonSerializable(typeof(AppInstallRequest))]
[JsonSerializable(typeof(AppFeedInstallPlanRequest))]
[JsonSerializable(typeof(AppFeedInstallApplyRequest))]
[JsonSerializable(typeof(AppConfigureRequest))]
[JsonSerializable(typeof(AppAutostartRequest))]
[JsonSerializable(typeof(AppFeedRequest))]
[JsonSerializable(typeof(AppDevelopmentModeRequest))]
[JsonSerializable(typeof(AppMountsRequest))]
[JsonSerializable(typeof(GlobalMountUpsertRequest))]
[JsonSerializable(typeof(AppUpdatePlanRequest))]
[JsonSerializable(typeof(AppUpdateApplyRequest))]
[JsonSerializable(typeof(AppRuntimeSwitchPlanRequest))]
[JsonSerializable(typeof(AppRuntimeSwitchApplyRequest))]
[JsonSerializable(typeof(ReassignPortPlanRequest))]
[JsonSerializable(typeof(ReassignPortRequest))]
[JsonSerializable(typeof(ReassignPortPlan))]
[JsonSerializable(typeof(ReassignPortResult))]
[JsonSerializable(typeof(AppRemoveRequest))]
[JsonSerializable(typeof(AppBackupCleanupApplyRequest))]
[JsonSerializable(typeof(AppManualBackupRequest))]
[JsonSerializable(typeof(AppInitiatedBackupRequest))]
[JsonSerializable(typeof(AppNotificationCreateRequest))]
[JsonSerializable(typeof(NotificationMarkReadRequest))]
[JsonSerializable(typeof(AppRestoreBackupRequest))]
[JsonSerializable(typeof(AppIdentityIssueRequest))]
[JsonSerializable(typeof(AppOpenLinkRequest))]
[JsonSerializable(typeof(UserInvitationCreateRequest))]
[JsonSerializable(typeof(UserInvitationAcceptRequest))]
[JsonSerializable(typeof(HostUserUpdateRequest))]
[JsonSerializable(typeof(HostUserAssignmentsRequest))]

// HTTP responses / results.
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(CoreStatusResponse))]
[JsonSerializable(typeof(StopResponse))]
[JsonSerializable(typeof(CoreRestartResponse))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(ManifestErrorResponse))]
[JsonSerializable(typeof(AuthSessionResponse))]
[JsonSerializable(typeof(CsrfResponse))]
[JsonSerializable(typeof(LogoutResponse))]
[JsonSerializable(typeof(AppsResponse))]
[JsonSerializable(typeof(InstalledAppsResponse))]
[JsonSerializable(typeof(AppDirectoryResponse))]
[JsonSerializable(typeof(AppUpdateAvailabilityResponse))]
[JsonSerializable(typeof(UsersResponse))]
[JsonSerializable(typeof(AuditResponse))]
[JsonSerializable(typeof(AppDirectoryUsersResponse))]
[JsonSerializable(typeof(HostUsersSummaryResponse))]
[JsonSerializable(typeof(AppIdentityIssueResponse))]
[JsonSerializable(typeof(AppOpenLinkResponse))]
[JsonSerializable(typeof(AuthBootstrapCompleteResponse))]
[JsonSerializable(typeof(AuthRecoveryCompleteResponse))]
[JsonSerializable(typeof(AuthBootstrapTokenResponse))]
[JsonSerializable(typeof(AppSourceResponse))]
[JsonSerializable(typeof(AppSourceCleanupPlan))]
[JsonSerializable(typeof(AppSourceCleanupApplyResponse))]
[JsonSerializable(typeof(AppAuthorizeResult))]
[JsonSerializable(typeof(AppIdentityTokenResult))]
[JsonSerializable(typeof(AppSessionValidationResult))]
[JsonSerializable(typeof(AppInstallPlan))]
[JsonSerializable(typeof(AppFeedInstallPlan))]
[JsonSerializable(typeof(AppFeedInstallPlanDigestSeed))]
[JsonSerializable(typeof(AppFeedsResponse))]
[JsonSerializable(typeof(AppLifecycleResponse))]
// Reachable via AppLifecycleResponse, but rooted explicitly for parity with the other nested DTOs:
// the Development-Mode disable rollback recommendation.
[JsonSerializable(typeof(AppDevelopmentModeRestoreHint))]
[JsonSerializable(typeof(GlobalMountListResponse))]
[JsonSerializable(typeof(AppUpdatePlan))]
[JsonSerializable(typeof(AppRuntimeSwitchPlan))]
[JsonSerializable(typeof(AppBackupsResponse))]
[JsonSerializable(typeof(AppBackupResponse))]
[JsonSerializable(typeof(AppInitiatedBackupResponse))]
[JsonSerializable(typeof(NotificationView))]
[JsonSerializable(typeof(AppNotificationCreateResponse))]
[JsonSerializable(typeof(NotificationsResponse))]
[JsonSerializable(typeof(NotificationMarkReadResponse))]
[JsonSerializable(typeof(AppBackupDeleteResponse))]
[JsonSerializable(typeof(AppBackupCleanupPlan))]
[JsonSerializable(typeof(AppBackupCleanupApplyResponse))]
[JsonSerializable(typeof(AppLogsResponse))]
[JsonSerializable(typeof(AppRuntimeHealthResponse))]
[JsonSerializable(typeof(AppUpdateStatusResponse))]
[JsonSerializable(typeof(UserManagementStateResponse))]
[JsonSerializable(typeof(UserInvitationsResponse))]
[JsonSerializable(typeof(UserInvitationCreateResponse))]
[JsonSerializable(typeof(UserInvitationPreview))]
[JsonSerializable(typeof(UserInvitationAcceptResponse))]
[JsonSerializable(typeof(UserInvitationRevokeResponse))]
[JsonSerializable(typeof(UserManagementHostUserSummary))]
[JsonSerializable(typeof(HostUserUpdateResponse))]
[JsonSerializable(typeof(HostUserDisableResponse))]
[JsonSerializable(typeof(HostUserAssignmentsResponse))]
internal sealed partial class CoreJsonSerializerContext : JsonSerializerContext;
