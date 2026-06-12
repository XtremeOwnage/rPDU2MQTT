using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>The default config source: a YAML file on disk (see <see cref="YamlConfigLoader"/>).</summary>
public sealed class FileConfigSource : IConfigSource
{
    public string Describe => $"file ({YamlConfigLoader.ResolvedPath ?? "unresolved"})";
    public bool IsGitOpsManaged => false;

    public bool CanWrite
    {
        get
        {
            var path = YamlConfigLoader.ResolvedPath;
            if (string.IsNullOrEmpty(path))
                return false;
            try
            {
                if (File.Exists(path))
                {
                    using var fs = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
                    return true;
                }
                var dir = Path.GetDirectoryName(path);
                return !string.IsNullOrEmpty(dir) && Directory.Exists(dir);
            }
            catch
            {
                return false;
            }
        }
    }

    public Config Load() => YamlConfigLoader.GetConfig();

    public async Task SaveAsync(Config config, CancellationToken cancellationToken)
    {
        var path = YamlConfigLoader.ResolvedPath
            ?? throw new InvalidOperationException("Config file path is unknown; cannot save.");

        // Keep a single rolling backup before overwriting.
        if (File.Exists(path))
            File.Copy(path, path + ".bak", overwrite: true);

        await File.WriteAllTextAsync(path, ConfigSchema.ToYaml(config), cancellationToken);
    }
}
