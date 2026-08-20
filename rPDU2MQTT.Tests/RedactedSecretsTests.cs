using System.Reflection;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Every secret in the config is redacted before it leaves the process.
///
/// <para>
/// <c>RedactSecrets</c> is a hand-kept list, and its output is what the GUI renders as an RpduConfig
/// manifest for GitOps re-import — so a credential added to the model and forgotten here does not fail
/// anything, it just travels. This walks the whole config tree instead of trusting the list: fill every
/// secret-shaped property with a marker, redact, and go looking for the marker.
/// </para>
/// </summary>
public class RedactedSecretsTests
{
    private const string Marker = "SUPER-SECRET-VALUE";

    /// <summary>What counts as a secret, by the name an operator would give it.</summary>
    private static bool IsSecret(PropertyInfo p)
        => p.PropertyType == typeof(string)
        && new[] { "password", "apikey", "token", "secret" }
            .Any(n => p.Name.Replace("_", "").Contains(n, StringComparison.OrdinalIgnoreCase));

    /// <summary>Fill every secret-shaped string in the tree, and every object hanging off it.</summary>
    private static int Fill(object? node, HashSet<object> seen, int depth = 0)
    {
        if (node is null || depth > 6 || !seen.Add(node)) return 0;
        var filled = 0;

        foreach (var p in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.GetIndexParameters().Length > 0) continue;

            if (IsSecret(p) && p.CanWrite) { p.SetValue(node, Marker); filled++; continue; }
            if (p.PropertyType.IsPrimitive || p.PropertyType.IsEnum || p.PropertyType == typeof(string)) continue;

            object? child;
            try { child = p.GetValue(node); } catch { continue; }
            if (child is null && p.CanWrite && p.PropertyType.GetConstructor(Type.EmptyTypes) is not null)
            {
                child = Activator.CreateInstance(p.PropertyType);
                p.SetValue(node, child);
            }

            if (child is System.Collections.IEnumerable items and not string)
                foreach (var item in items) filled += Fill(item, seen, depth + 1);
            else filled += Fill(child, seen, depth + 1);
        }
        return filled;
    }

    private static IEnumerable<string> Leaks(object? node, string path, HashSet<object> seen, int depth = 0)
    {
        if (node is null || depth > 6 || !seen.Add(node)) yield break;

        foreach (var p in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.GetIndexParameters().Length > 0) continue;
            object? value;
            try { value = p.GetValue(node); } catch { continue; }
            if (value is null) continue;

            if (value is string s)
            {
                if (s.Contains(Marker, StringComparison.Ordinal)) yield return $"{path}.{p.Name}";
                continue;
            }
            if (p.PropertyType.IsPrimitive || p.PropertyType.IsEnum) continue;

            if (value is System.Collections.IEnumerable items)
            {
                var i = 0;
                foreach (var item in items)
                    foreach (var leak in Leaks(item, $"{path}.{p.Name}[{i++}]", seen, depth + 1)) yield return leak;
                continue;
            }
            foreach (var leak in Leaks(value, $"{path}.{p.Name}", seen, depth + 1)) yield return leak;
        }
    }

    [Fact]
    public void NoSecretSurvivesRedaction()
    {
        var config = new Config();
        config.Pdus["default"] = new rPDU2MQTT.Models.Config.PduConfig();
        var filled = Fill(config, new HashSet<object>(ReferenceEqualityComparer.Instance));
        Assert.True(filled >= 5, $"the walk only found {filled} secret-shaped properties — it is not covering the model");

        var redacted = ConfigSchema.RedactSecrets(config);

        var leaks = Leaks(redacted, "Config", new HashSet<object>(ReferenceEqualityComparer.Instance)).ToList();
        Assert.True(leaks.Count == 0,
            "a credential survives RedactSecrets and would travel in the exported manifest:\n  "
          + string.Join("\n  ", leaks));
    }
}
