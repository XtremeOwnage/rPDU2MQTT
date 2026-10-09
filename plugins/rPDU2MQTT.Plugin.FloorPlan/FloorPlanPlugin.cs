using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.FloorPlan;

/// <summary>The Floor Plans page. Locations, placements and runs stay in the core config and APIs.</summary>
public sealed class FloorPlanPlugin : IIntegration, IGuiPageProvider, IStatusProvider
{
    public string Id => "floorplan";
    public string DisplayName => "Floor Plans";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    public IReadOnlyList<GuiPage> Pages { get; } =
    [
        new("floor-plans", "Floor Plans", "Energy Flow", "⌗",
            "EnergyFlow.Sites,EnergyFlow.Placements,EnergyFlow.Runs,EnergyFlow.AutoLocations,EnergyFlow.Panels"),
    ];

    public string? PageAsset(string file) => GuiPageAssets.Read(typeof(FloorPlanPlugin).Assembly, file);

    public bool Enabled(Config cfg) => true;

    public IntegrationHealth Status(Config cfg)
    {
        var floors = (cfg.EnergyFlow.Sites ?? []).Sum(s => s.Floors?.Count ?? 0);
        return new(HealthLevel.Good, "Available", floors == 1 ? "1 floor" : $"{floors} floors");
    }
}
