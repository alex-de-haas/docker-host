using Haas.Hosty.Core;

// Publication validates the generated manifest using the same admission contract as installation.
// This tool neither starts Core nor executes source setup or application lifecycle commands.
if (args.Length < 2) throw new ArgumentException("Supply an absolute manifest path and production profile keys.");
if (!Path.IsPathFullyQualified(args[0])) throw new ArgumentException("Manifest path must be absolute.");
foreach (var profile in args.Skip(1))
{
    var selection = await new AppManifestService().LoadAsync(args[0], profile,
        validateAllProfiles: true, requirePanelIcons: true);
    if (selection.Manifest.SchemaVersion != "app.0.2") throw new InvalidOperationException("Release requires app.0.2.");
    Console.WriteLine($"Validated {selection.Manifest.Id}/{profile}: {selection.ManifestDigest}");
}
