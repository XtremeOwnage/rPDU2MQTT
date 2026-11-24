using System.Net;
using System.Net.Sockets;

namespace rPDU2MQTT.Helpers;

/// <summary>An IPv4 or IPv6 range in CIDR notation; a bare address is a single host.</summary>
public readonly record struct Cidr(IPAddress Network, int Prefix)
{
    public static bool TryParse(string? text, out Cidr cidr)
    {
        cidr = default;
        var s = text?.Trim();
        if (string.IsNullOrEmpty(s)) return false;

        var slash = s.IndexOf('/');
        if (!IPAddress.TryParse(slash < 0 ? s : s[..slash], out var ip)) return false;
        ip = Normalize(ip);
        var max = ip.AddressFamily == AddressFamily.InterNetwork ? 32 : 128;

        var prefix = max;
        if (slash >= 0 && (!int.TryParse(s[(slash + 1)..], System.Globalization.NumberStyles.None, null, out prefix) || prefix > max))
            return false;

        cidr = new Cidr(Mask(ip, prefix), prefix);
        return true;
    }

    public bool Contains(IPAddress address)
    {
        var ip = Normalize(address);
        return ip.AddressFamily == Network.AddressFamily && Mask(ip, Prefix).Equals(Network);
    }

    public override string ToString() => $"{Network}/{Prefix}";

    internal static IPAddress Normalize(IPAddress ip) => ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip;

    private static IPAddress Mask(IPAddress ip, int prefix)
    {
        var bytes = ip.GetAddressBytes();
        for (var i = 0; i < bytes.Length; i++)
        {
            var bits = Math.Clamp(prefix - i * 8, 0, 8);
            bytes[i] &= (byte)(0xFF << (8 - bits));
        }
        return new IPAddress(bytes);
    }
}

/// <summary>Client address resolution and matching for <c>Gui.TrustedNetworks</c> / <c>Gui.TrustedProxies</c>.</summary>
public static class TrustedNetworks
{
    /// <summary>Parse a list of CIDRs, returning the valid ones and the entries that could not be read.</summary>
    public static (IReadOnlyList<Cidr> Valid, IReadOnlyList<string> Invalid) Parse(IEnumerable<string>? entries)
    {
        var valid = new List<Cidr>();
        var invalid = new List<string>();
        foreach (var e in entries ?? [])
        {
            if (string.IsNullOrWhiteSpace(e)) continue;
            if (Cidr.TryParse(e, out var c)) valid.Add(c);
            else invalid.Add(e);
        }
        return (valid, invalid);
    }

    /// <summary>Split a comma-separated list, e.g. an environment variable.</summary>
    public static List<string> Split(string? value) =>
        (value ?? "").Split([',', ';', ' ', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    /// <summary>GUI endpoints a read-only viewer may not read: logs, the broker, Home Assistant and deployment admin.</summary>
    private static readonly string[] Withheld =
        ["/api/diagnostics", "/api/mqtt", "/api/ha", "/api/operator", "/api/discover", "/api/restart"];

    /// <summary>POST endpoints that only compute an answer; integration actions are further limited to read actions.</summary>
    private static readonly string[] ReadOnlyPosts = ["/api/flow/live", "/api/panels/resolve"];

    /// <summary>Whether a read-only viewer may make this request.</summary>
    public static bool ViewerMayRequest(string method, string? path)
    {
        var p = path ?? "";
        if (HttpMethodIs(method, "GET") || HttpMethodIs(method, "HEAD"))
            return !Withheld.Any(w => p.Equals(w, StringComparison.OrdinalIgnoreCase) || p.StartsWith(w + "/", StringComparison.OrdinalIgnoreCase));
        if (HttpMethodIs(method, "POST"))
            return ReadOnlyPosts.Any(r => p.Equals(r, StringComparison.OrdinalIgnoreCase)) || IsIntegrationAction(p);
        return false;
    }

    private static readonly string[] KioskGets =
        ["/kiosk", "/styles.css", "/app.js", "/api/status", "/api/status/board", "/api/flow", "/api/flow/series", "/api/events"];

    private static readonly string[] KioskTopics = ["flow:realpower", "status"];

    /// <summary>Whether a request is one the kiosk view makes.</summary>
    public static bool KioskMayRequest(string method, string? path, string? topics)
    {
        var p = (path ?? "").TrimEnd('/');
        if (HttpMethodIs(method, "POST"))
            return p.Equals("/api/flow/live", StringComparison.OrdinalIgnoreCase);
        if (!HttpMethodIs(method, "GET") && !HttpMethodIs(method, "HEAD"))
            return false;
        if (!KioskGets.Any(k => p.Equals(k, StringComparison.OrdinalIgnoreCase)))
            return false;
        return !p.Equals("/api/events", StringComparison.OrdinalIgnoreCase)
            || (topics ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).All(t => KioskTopics.Contains(t));
    }

    /// <summary>/api/integrations/{id}/{action}.</summary>
    private static bool IsIntegrationAction(string path)
    {
        var parts = path.Split('/');
        return parts.Length == 5 && parts[0] == "" && parts[1].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[2].Equals("integrations", StringComparison.OrdinalIgnoreCase) && parts[3] != "" && parts[4] != "";
    }

    private static bool HttpMethodIs(string method, string expected) => string.Equals(method, expected, StringComparison.OrdinalIgnoreCase);

    public static bool InAny(IPAddress? address, IReadOnlyList<Cidr> ranges) =>
        address is not null && ranges.Any(r => r.Contains(address));

    /// <summary>
    /// The client address: the socket peer, then X-Forwarded-For walked right to left for as long as the
    /// hop that added each entry is a trusted proxy.
    /// </summary>
    public static IPAddress? ClientAddress(IPAddress? remote, IEnumerable<string?> forwardedFor, IReadOnlyList<Cidr> proxies)
    {
        if (remote is null) return null;
        var address = Cidr.Normalize(remote);
        if (proxies.Count == 0) return address;

        var hops = forwardedFor
            .SelectMany(h => (h ?? "").Split(',', StringSplitOptions.TrimEntries))
            .ToList();

        for (var i = hops.Count - 1; i >= 0 && InAny(address, proxies); i--)
        {
            if (!TryParseHop(hops[i], out var hop)) break;
            address = hop;
        }
        return address;
    }

    /// <summary>One X-Forwarded-For entry: an address, optionally with a port or IPv6 brackets.</summary>
    private static bool TryParseHop(string hop, out IPAddress address)
    {
        address = IPAddress.None;
        if (string.IsNullOrEmpty(hop)) return false;
        if (!IPAddress.TryParse(hop, out var ip))
        {
            if (!IPEndPoint.TryParse(hop, out var ep)) return false;
            ip = ep.Address;
        }
        address = Cidr.Normalize(ip);
        return true;
    }
}
