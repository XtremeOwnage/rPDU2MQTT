using Microsoft.Extensions.DependencyInjection;
using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// One PDU outlet (key <c>deviceId|index</c>). Holds the outlet's observed state (from the parent PDU grain's
/// poll fan-out) and executes writes against the physical PDU. Single activation, so a control action runs
/// exactly once cluster-wide — the leaf of the PDU → outlets tree.
/// </summary>
public sealed class OutletGrain : Grain, IOutletGrain
{
    private readonly IServiceProvider sp;
    private OutletState? state;
    private string deviceId = "";
    private int index;

    public OutletGrain(IServiceProvider sp) => this.sp = sp;

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var key = this.GetPrimaryKeyString();
        var sep = key.LastIndexOf('|');   // deviceId may itself contain '|'; the index is after the last one
        if (sep > 0) { deviceId = key[..sep]; int.TryParse(key[(sep + 1)..], out index); }
        return base.OnActivateAsync(cancellationToken);
    }

    public Task Observe(OutletState s) { state = s; return Task.CompletedTask; }

    public Task<OutletState?> State() => Task.FromResult(state);

    public async Task<string> Control(string action)
    {
        var pdu = sp.GetService<PDU>();
        if (pdu is null) return "No PDU available to control this outlet.";
        switch (action.Trim().ToLowerInvariant())
        {
            case "on": await pdu.SetOutletStateAsync(deviceId, index, true, CancellationToken.None); break;
            case "off": await pdu.SetOutletStateAsync(deviceId, index, false, CancellationToken.None); break;
            case "reboot": await pdu.ControlOutletAsync(deviceId, index, "reboot", CancellationToken.None); break;
            case "resetstats": await pdu.ResetOutletStatsAsync(deviceId, index, CancellationToken.None); break;
            default: return $"Unknown outlet action '{action}'.";
        }
        return $"{deviceId} outlet {index}: {action}.";
    }

    public async Task<string> SetConfig(string field, string payload, bool isDelay)
    {
        var pdu = sp.GetService<PDU>();
        if (pdu is null) return "";
        object value;
        if (isDelay)
        {
            // HA sends the number as text; the API wants an integer.
            if (!double.TryParse(payload, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var num)) return "";
            value = (long)Math.Round(num);
        }
        else value = payload;   // poaAction etc.: the selected option string

        await pdu.SetOutletConfigAsync(deviceId, index, new Dictionary<string, object> { [field] = value }, CancellationToken.None);
        return value.ToString() ?? "";
    }
}
