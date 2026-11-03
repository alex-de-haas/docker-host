using HostySdk.App;
namespace Haas.Hosty.Core;

internal sealed record CoreDecisionReplay(string Key, string Fingerprint, string DecisionId, HostyDecisionRecord? Result);
internal sealed record CoreDecisionState(int SchemaVersion, long Sequence, IReadOnlyList<HostyDecisionRecord> Records,
    IReadOnlyList<CoreDecisionReplay> Replays)
{
    internal static readonly CoreDecisionState Empty = new(1, 0, [], []);
}
