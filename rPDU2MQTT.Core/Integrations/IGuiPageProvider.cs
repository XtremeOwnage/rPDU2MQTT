using System.Reflection;
using System.Text.RegularExpressions;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>A page a plugin draws in the GUI, shipped in the plugin's own assembly.</summary>
/// <param name="Id">The page's file name without extension: the host serves <c>{Id}.js</c> and <c>{Id}.css</c>.</param>
/// <param name="Title">The nav entry.</param>
/// <param name="Group">The nav group: "Sources", "Energy Flow", "Integrations", "Destinations" or "System".</param>
/// <param name="Icon">A glyph for the nav entry.</param>
/// <param name="ConfigSection">Comma-separated config paths the page edits, for its nav badge (e.g. "Plugins.tigo.Strings").</param>
public sealed record GuiPage(string Id, string Title, string Group, string? Icon = null, string? ConfigSection = null);

/// <summary>An integration with its own GUI pages; each script is a function body returning <c>mount(section, host)</c>.</summary>
public interface IGuiPageProvider
{
    IReadOnlyList<GuiPage> Pages { get; }

    /// <summary>A page's script or stylesheet ("{id}.js" or "{id}.css"), or null when there is none.</summary>
    string? PageAsset(string file);

    /// <summary>Keys under <c>Plugins.{id}</c> that only the pages read; saving them needs no restart.</summary>
    IReadOnlyList<string> PageSettings => [];
}

public static partial class GuiPageAssets
{
    /// <summary>A page asset embedded in <paramref name="assembly"/>, matched by file name.</summary>
    public static string? Read(Assembly assembly, string file)
    {
        if (!IsAssetName(file)) return null;
        var name = assembly.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("." + file, StringComparison.OrdinalIgnoreCase));
        if (name is null) return null;
        using var stream = assembly.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static bool IsAssetName(string file) => AssetName().IsMatch(file);

    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]*\.(js|css)$")]
    private static partial Regex AssetName();
}
