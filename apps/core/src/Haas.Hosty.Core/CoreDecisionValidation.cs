using HostySdk.App;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal static class CoreDecisionValidation
{
    internal static CoreProviderException Invalid(string message) => new("decision_invalid", message, 400);
    internal static CoreProviderException Conflict(string message) => new("decision_conflict", message, 409);
    internal static CoreProviderException Missing() => new("decision_not_found", "Decision is unavailable.", 404);
    internal static void Text(string? value, int maximum, string field, bool required = false)
    {
        if ((required && string.IsNullOrWhiteSpace(value)) || value?.Length > maximum || value?.Contains('\0') == true)
            throw Invalid($"{field} must contain {(required ? "1" : "0")}–{maximum} characters.");
    }
    internal static string Uuid(string id) => Guid.TryParseExact(id, "D", out var value)
        ? value.ToString("D") : throw Invalid("Use a stable UUID request ID.");
    internal static string Fingerprint<T>(T value)
    {
        var json = JsonSerializer.SerializeToElement(value, CoreJson.TypeInfo<T>());
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) Canonical(json, writer);
        if (stream.Length > 65536) throw Invalid("Decision input exceeds 64 KiB.");
        return Convert.ToHexString(SHA256.HashData(stream.ToArray()));
    }
    private static void Canonical(JsonElement value, Utf8JsonWriter writer)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
            { writer.WritePropertyName(property.Name); Canonical(property.Value, writer); }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        { writer.WriteStartArray(); foreach (var item in value.EnumerateArray()) Canonical(item, writer); writer.WriteEndArray(); }
        else value.WriteTo(writer);
    }
    internal static void Input(HostyDecisionInput input, DateTimeOffset now)
    {
        if (input is null) throw Invalid("Decision input is required.");
        Text(input.CorrelationKey, 200, "Correlation key", true);
        Text(input.Title, 160, "Title", true); Text(input.Reason, 4000, "Reason");
        Text(input.OriginPath, 2000, "Origin path"); Text(input.WaitReference, 200, "Wait reference");
        Text(input.PredecessorId, 80, "Predecessor");
        if (input.OriginPath is { } path && (!path.StartsWith('/') || path.StartsWith("//") || path.Contains('\\') || path.Any(char.IsControl)))
            throw Invalid("Origin path must be an application-relative route.");
        if (input.ExpiresAt <= now) throw Invalid("The deadline has already passed.");
        if (input.Questions is not { Count: >= 1 and <= 4 } || input.Questions.Any(q => q is null))
            throw Invalid("Provide one to four questions.");
        if (input.Questions.Select(q => q.Id).Distinct(StringComparer.Ordinal).Count() != input.Questions.Count)
            throw Invalid("Question IDs must be unique.");
        foreach (var question in input.Questions)
        {
            Text(question.Id, 100, "Question ID", true); Text(question.Question, 4000, "Question", true); Text(question.Header, 100, "Header");
            var options = question.Options ?? [];
            if (options.Count > 8 || options.Any(o => o is null) || options.Select(o => o.Id).Distinct(StringComparer.Ordinal).Count() != options.Count
                || (!question.AllowText && options.Count == 0)) throw Invalid("Provide up to eight distinct options or allow a text answer.");
            foreach (var option in options)
            { Text(option.Id, 100, "Option ID", true); Text(option.Label, 500, "Option", true); Text(option.Description, 2000, "Option description"); }
        }
        if (input.Materials?.Count > 16) throw Invalid("At most sixteen material references are allowed.");
        foreach (var reference in (input.Materials ?? []).Concat(new[] { input.Subject, input.Task }.OfType<HostyDecisionReference>()))
        {
            if (reference is null) throw Invalid("A material reference cannot be null.");
            Text(reference.Kind, 80, "Reference kind", true); Text(reference.Id, 2000, "Reference ID", true); Text(reference.Revision, 200, "Reference revision");
        }
    }
    internal static void Answers(HostyDecisionInput input, IReadOnlyDictionary<string, HostyDecisionAnswer> answers)
    {
        if (answers is null || answers.Count != input.Questions.Count || input.Questions.Any(q => !answers.ContainsKey(q.Id)))
            throw Invalid("Answer each question exactly once using its ID.");
        foreach (var question in input.Questions)
        {
            var answer = answers[question.Id];
            if (answer is null) throw Invalid("An answer cannot be null.");
            Text(answer.Text, 4000, "Answer");
            var selected = answer.OptionIds ?? [];
            if (selected.Count > (question.Multiple ? 8 : 1) || selected.Distinct(StringComparer.Ordinal).Count() != selected.Count
                || selected.Any(id => !(question.Options ?? []).Any(o => o.Id == id))) throw Invalid("Choose distinct options from this question.");
            if ((!question.AllowText && !string.IsNullOrEmpty(answer.Text)) || (selected.Count == 0 && string.IsNullOrWhiteSpace(answer.Text)))
                throw Invalid("Provide an allowed answer.");
        }
    }
    internal static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
