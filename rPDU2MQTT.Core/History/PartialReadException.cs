namespace rPDU2MQTT.Core.History;

/// <summary>Some of a history read failed; <see cref="Found"/> holds what did arrive, so it is not thrown away with the rest.</summary>
public sealed class PartialReadException(string message, IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>> found, int failed)
    : Exception(message)
{
    public IReadOnlyDictionary<string, IReadOnlyList<(DateTime At, double Value)>> Found { get; } = found;
    public int Failed { get; } = failed;
}
