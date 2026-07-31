using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

// Pending device authorization requests, held in memory only.
//
// Durability would buy nothing here: a request lives ten minutes, and a Core restart during those ten
// minutes leaves the device polling, which answers `expired` and starts over — the same recovery the
// device already needs for a code the operator ignored. Persisting them would add a file, a schema and a
// migration to protect a value that is worthless a few minutes later.
internal sealed class DeviceAuthorizationStore(IClock clock)
{
    // How long an unapproved request survives. Long enough to walk to a browser, short enough that an
    // abandoned code is not sitting there when someone else looks at the approval list.
    public static readonly TimeSpan RequestLifetime = TimeSpan.FromMinutes(10);

    // What the device is told to wait between polls.
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    // Outstanding requests allowed per source address. Deliberately per source and not global: a single
    // global ceiling would be the availability hole rather than the fix, because on an internet-reachable
    // Core one caller could hold it full and block every legitimate enrollment while staying well inside
    // any memory budget.
    public const int MaxPendingPerSource = 5;

    // The alphabet excludes characters that are read wrong off a small screen: 0/O, 1/I/L, 5/S, 2/Z.
    private const string UserCodeAlphabet = "ABCDEFGHJKMNPQRTUVWXY346789";
    private const int UserCodeLength = 8;

    private readonly ConcurrentDictionary<string, DeviceAuthorizationRequest> requests = new(StringComparer.Ordinal);

    public DeviceAuthorizationCreateResult Create(string? label, string sourceKey)
    {
        var now = clock.UtcNow;
        Sweep(now);

        var pendingFromSource = requests.Values.Count(request =>
            request.Status == DeviceAuthorizationStatus.Pending &&
            string.Equals(request.SourceKey, sourceKey, StringComparison.Ordinal));
        if (pendingFromSource >= MaxPendingPerSource)
        {
            return new DeviceAuthorizationCreateResult(null, TooManyPending: true);
        }

        var request = new DeviceAuthorizationRequest(
            DeviceCode: Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
            UserCode: CreateUserCode(),
            Label: NormalizeLabel(label),
            SourceKey: sourceKey,
            CreatedAt: now,
            ExpiresAt: now.Add(RequestLifetime));

        requests[request.DeviceCode] = request;
        return new DeviceAuthorizationCreateResult(request, TooManyPending: false);
    }

    // Every pending request, newest first, for the approval surface.
    public IReadOnlyList<DeviceAuthorizationRequest> ListPending()
    {
        var now = clock.UtcNow;
        Sweep(now);
        return requests.Values
            .Where(request => request.Status == DeviceAuthorizationStatus.Pending && request.ExpiresAt > now)
            .OrderByDescending(request => request.CreatedAt)
            .ToArray();
    }

    // Resolve by the code a human typed, which is the only identifier the approver ever sees. Matching is
    // case-insensitive because the operator reads it off a small screen and a keyboard is not a scanner.
    public DeviceAuthorizationRequest? FindByUserCode(string userCode)
    {
        if (string.IsNullOrWhiteSpace(userCode))
        {
            return null;
        }

        var now = clock.UtcNow;
        Sweep(now);
        var normalized = userCode.Trim().Replace("-", string.Empty, StringComparison.Ordinal);
        return requests.Values.FirstOrDefault(request =>
            request.Status == DeviceAuthorizationStatus.Pending &&
            request.ExpiresAt > now &&
            string.Equals(request.UserCode, normalized, StringComparison.OrdinalIgnoreCase));
    }

    // Attach the issued credential to the request so the next poll can collect it. Returns false when the
    // request was taken, denied or expired in the meantime, so the caller does not issue a second one.
    public bool TryApprove(string deviceCode, string sessionId, string approvedByUserId)
        => TryTransition(deviceCode, request => request with
        {
            Status = DeviceAuthorizationStatus.Approved,
            SessionId = sessionId,
            ApprovedByUserId = approvedByUserId,
        });

    public bool TryDeny(string deviceCode)
        => TryTransition(deviceCode, request => request with { Status = DeviceAuthorizationStatus.Denied });

    // The device polling for its answer. An approved request is consumed on read: the credential is
    // handed over exactly once, so a replayed device code cannot collect it again.
    public DeviceAuthorizationPollResult Poll(string deviceCode)
    {
        var now = clock.UtcNow;
        Sweep(now);

        if (string.IsNullOrWhiteSpace(deviceCode) || !requests.TryGetValue(deviceCode, out var request))
        {
            return new DeviceAuthorizationPollResult(DeviceAuthorizationStatus.Expired, null);
        }

        switch (request.Status)
        {
            case DeviceAuthorizationStatus.Approved:
                requests.TryRemove(deviceCode, out _);
                return new DeviceAuthorizationPollResult(DeviceAuthorizationStatus.Approved, request.SessionId);
            case DeviceAuthorizationStatus.Denied:
                requests.TryRemove(deviceCode, out _);
                return new DeviceAuthorizationPollResult(DeviceAuthorizationStatus.Denied, null);
            default:
                return request.ExpiresAt <= now
                    ? new DeviceAuthorizationPollResult(DeviceAuthorizationStatus.Expired, null)
                    : new DeviceAuthorizationPollResult(DeviceAuthorizationStatus.Pending, null);
        }
    }

    private bool TryTransition(string deviceCode, Func<DeviceAuthorizationRequest, DeviceAuthorizationRequest> transition)
    {
        var now = clock.UtcNow;
        if (!requests.TryGetValue(deviceCode, out var current) ||
            current.Status != DeviceAuthorizationStatus.Pending ||
            current.ExpiresAt <= now)
        {
            return false;
        }

        // Compare-and-swap so two approvers racing the same code produce one credential, not two.
        return requests.TryUpdate(deviceCode, transition(current), current);
    }

    // Expired requests are dropped on every operation rather than by a timer: the dictionary only grows
    // when someone is enrolling, and every path through here already touches it.
    private void Sweep(DateTimeOffset now)
    {
        foreach (var entry in requests)
        {
            if (entry.Value.ExpiresAt <= now)
            {
                requests.TryRemove(entry.Key, out _);
            }
        }
    }

    private static string CreateUserCode()
    {
        var characters = new char[UserCodeLength];
        for (var index = 0; index < characters.Length; index++)
        {
            characters[index] = UserCodeAlphabet[RandomNumberGenerator.GetInt32(UserCodeAlphabet.Length)];
        }

        return new string(characters);
    }

    // A device supplies its own label, so it is untrusted display text: bound the length and drop control
    // characters before it reaches an approval screen or a credential list.
    internal static string? NormalizeLabel(string? label)
    {
        if (string.IsNullOrWhiteSpace(label))
        {
            return null;
        }

        var cleaned = new string(label.Trim().Where(character => !char.IsControl(character)).ToArray());
        return cleaned.Length == 0
            ? null
            : cleaned[..Math.Min(cleaned.Length, 64)];
    }
}

internal enum DeviceAuthorizationStatus
{
    Pending,
    Approved,
    Denied,
    Expired,
}

internal sealed record DeviceAuthorizationRequest(
    string DeviceCode,
    string UserCode,
    string? Label,
    string SourceKey,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DeviceAuthorizationStatus Status = DeviceAuthorizationStatus.Pending,
    string? SessionId = null,
    string? ApprovedByUserId = null);

internal sealed record DeviceAuthorizationCreateResult(DeviceAuthorizationRequest? Request, bool TooManyPending);

internal sealed record DeviceAuthorizationPollResult(DeviceAuthorizationStatus Status, string? SessionId);
