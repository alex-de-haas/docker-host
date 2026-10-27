using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>Typed version-one task operations, with fresh Core authority and no implicit mutation retries.</summary>
public sealed class HostyTaskClient(HostyProviderClient providers, HostyTaskProviderRef provider, Func<Task<string>>? userToken = null)
{
    /// <summary>Read provider capabilities.</summary>
    public Task<HostyTaskCapabilities> CapabilitiesAsync(CancellationToken ct = default) => Send<HostyTaskCapabilities>("/capabilities", HttpMethod.Get, null, ct);
    /// <summary>List a bounded page.</summary>
    public Task<HostyTaskPage> ListAsync(string? cursor = null, int limit = 50, string? status = null, CancellationToken ct = default)
        => Send<HostyTaskPage>($"/tasks?limit={limit}&cursor={Uri.EscapeDataString(cursor ?? "")}&status={Uri.EscapeDataString(status ?? "")}", HttpMethod.Get, null, ct);
    /// <summary>Create once under RequestId.</summary>
    public Task<HostyTaskRecord> CreateAsync(HostyTaskCreate input, CancellationToken ct = default) => Send<HostyTaskRecord>("/tasks", HttpMethod.Post, input, ct);
    /// <summary>Read the current task.</summary>
    public Task<HostyTaskRecord> GetAsync(HostyTaskRef task, CancellationToken ct = default) => Send<HostyTaskRecord>(Route(task), HttpMethod.Get, null, ct);
    /// <summary>Edit Draft inputs against the observed revision.</summary>
    public Task<HostyTaskRecord> EditAsync(HostyTaskRef task, HostyTaskEdit input, CancellationToken ct = default) => Send<HostyTaskRecord>(Route(task), HttpMethod.Patch, input, ct);
    /// <summary>Apply a lifecycle action.</summary>
    public Task<HostyTaskRecord> ActionAsync(HostyTaskRef task, HostyTaskAction input, CancellationToken ct = default) => Send<HostyTaskRecord>(Route(task) + "/actions", HttpMethod.Post, input, ct);
    private string Route(HostyTaskRef task)
    {
        if (task.AppId != provider.AppId || task.InstallationId != provider.InstallationId || task.Key != provider.Key)
            throw new ArgumentException("Task belongs to another provider installation.", nameof(task));
        return "/tasks/" + Uri.EscapeDataString(task.Id);
    }
    private async Task<T> Send<T>(string route, HttpMethod method, object? input, CancellationToken ct)
        => await HostyTaskTransport.Send<T>(providers, provider, "tasks", route, method, input, userToken, ct);
}

/// <summary>The three-operation durable execution protocol and opaque option discovery.</summary>
public sealed class HostyTaskExecutorClient(HostyProviderClient providers, HostyTaskProviderRef executor, Func<Task<string>>? userToken = null)
{
    /// <summary>Read currently selectable options.</summary>
    public Task<HostyTaskExecutorOptions> OptionsAsync(CancellationToken ct = default) => Send<HostyTaskExecutorOptions>("/options", HttpMethod.Get, null, ct);
    /// <summary>Accept an immutable execution or recover its original receipt.</summary>
    public Task<HostyTaskExecutionReceipt> AcceptAsync(string id, HostyTaskExecutionInput input, CancellationToken ct = default)
        => Send<HostyTaskExecutionReceipt>("/executions/" + Uri.EscapeDataString(id), HttpMethod.Put, input, ct);
    /// <summary>Observe a previously submitted execution.</summary>
    public Task<HostyTaskExecutionReceipt> GetAsync(string id, CancellationToken ct = default)
        => Send<HostyTaskExecutionReceipt>("/executions/" + Uri.EscapeDataString(id), HttpMethod.Get, null, ct);
    /// <summary>Request cancellation, including fencing acceptance that has not arrived yet.</summary>
    public Task<HostyTaskExecutionReceipt> CancelAsync(string id, string requestId, CancellationToken ct = default)
        => Send<HostyTaskExecutionReceipt>("/executions/" + Uri.EscapeDataString(id) + "/cancel", HttpMethod.Post, new TaskCancel(requestId), ct);
    private async Task<T> Send<T>(string route, HttpMethod method, object? input, CancellationToken ct)
        => await HostyTaskTransport.Send<T>(providers, executor, "task-executor", route, method, input, userToken, ct);
}
internal sealed record TaskCancel(string RequestId);
internal static class HostyTaskTransport
{
    public static async Task<T> Send<T>(HostyProviderClient client, HostyTaskProviderRef provider, string kind, string route,
        HttpMethod method, object? input, Func<Task<string>>? userToken, CancellationToken ct)
    {
        using var content = input is null ? null : JsonContent.Create(input, TaskJsonContext.Default.GetTypeInfo(input.GetType())!);
        using var response = await client.SendTaskAsync(provider, kind, userToken is null ? null : await userToken(), method, route, content, ct);
        var json = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            HostyTaskExecutionError? error = null;
            try { error = JsonSerializer.Deserialize(json, TaskJsonContext.Default.HostyTaskExecutionError); }
            catch (JsonException) { /* Preserve the HTTP failure even when the provider did not return JSON. */ }
            throw new HostyProviderException(error?.Code ?? "task_failed", error?.Message ?? "Task request failed.", (int)response.StatusCode);
        }
        try { return (T)(JsonSerializer.Deserialize(json, TaskJsonContext.Default.GetTypeInfo(typeof(T))!)
            ?? throw new HostyProviderException("provider_response_invalid", "Invalid task response.", 502)); }
        catch (JsonException) { throw new HostyProviderException("provider_response_invalid", "Invalid task response.", 502); }
    }
}
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(HostyTaskCreate))]
[JsonSerializable(typeof(HostyTaskEdit))]
[JsonSerializable(typeof(HostyTaskAction))]
[JsonSerializable(typeof(HostyTaskRecord))]
[JsonSerializable(typeof(HostyTaskPage))]
[JsonSerializable(typeof(HostyTaskCapabilities))]
[JsonSerializable(typeof(HostyTaskExecutorOptions))]
[JsonSerializable(typeof(HostyTaskExecutionInput))]
[JsonSerializable(typeof(HostyTaskExecutionReceipt))]
[JsonSerializable(typeof(HostyTaskExecutionError))]
[JsonSerializable(typeof(TaskCancel))]
internal partial class TaskJsonContext : JsonSerializerContext;
