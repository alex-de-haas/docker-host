namespace Haas.Hosty.Core;

internal sealed partial class PublicationService
{
    private static void ValidatePolicyAmendment(PublicationRecord record, PublicationCommand input,
        PublicationPolicyAmendment amendment)
    {
        if (record.Number is null || record.PublishedHead is null || record.PublishedHead != input.ExpectedHead ||
            record.Outcome is not null || input.Policy is null || amendment.PreviousPolicy is null ||
            string.IsNullOrWhiteSpace(amendment.Reason) || amendment.Reason.Length > 2000 || amendment.Reason.Any(char.IsControl))
            throw new PublicationException("policy_amendment_invalid", "Supply the published expectedHead, previousPolicy, replacement policy and a nonempty reason of at most 2000 characters for an unfinished merged publication.");
        ValidatePolicy(amendment.PreviousPolicy);
        if (CoreJson.Text(record.Policy) != CoreJson.Text(amendment.PreviousPolicy))
            throw new PublicationException("policy_changed", "The completion policy changed. Refresh and review its current requirements before amending.");
        if (input.Fork || input.Dependencies is not null || input.Cleanup || input.Outcome is not null ||
            input.Number is not null && input.Number != record.Number)
            throw new PublicationException("policy_amendment_invalid", "Amend only completion requirements; preserve repository, dependencies, cleanup and outcome.");
    }
}
