using System.ComponentModel;
using rPDU2MQTT.Updates;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Kubernetes operator settings (#210). When enabled (and running the <c>operator</c> role with the
/// Kubernetes config source), the app manages its own Deployment: it periodically checks the container
/// registry for newer images and, optionally, rolls the Deployment to a newer tag under a bounded policy.
/// A no-op outside Kubernetes.
/// </summary>
public class OperatorConfig
{
    [DefaultValue(false)]
    [Description("Enable the Kubernetes operator: let this release manage its own Deployment (registry update checks, optional self-update). Requires the Kubernetes config source and the 'operator' role. No effect otherwise.")]
    public bool Enabled { get; set; } = false;

    [DefaultValue(true)]
    [Description("Periodically check the container registry for a newer image and report it (in the CR status and the GUI Diagnostics page). Read-only — never changes the Deployment on its own.")]
    public bool CheckForUpdates { get; set; } = true;

    [DefaultValue(6)]
    [Description("How often to check the registry for updates, in hours.")]
    public int CheckIntervalHours { get; set; } = 6;

    [DefaultValue(UpdatePolicy.Minor)]
    [Description("How far an update may move the deployed version: Patch (same major.minor), Minor (same major, no breaking changes), or Major (any newer release).")]
    public UpdatePolicy Policy { get; set; } = UpdatePolicy.Minor;

    [DefaultValue(false)]
    [Description("Automatically roll the Deployment to the newest eligible release (bounded by Policy). Off by default — checking is safe, but applying an update restarts the workload.")]
    public bool AutoUpdate { get; set; } = false;

    [DefaultValue(null)]
    [Description("Override the registry host to query (e.g. ghcr.io). Defaults to the registry of the currently-deployed image.")]
    public string? Registry { get; set; } = null;

    [DefaultValue(null)]
    [Description("Override the repository to query (e.g. xtremeownage/rpdu2mqtt). Defaults to the repository of the currently-deployed image.")]
    public string? Repository { get; set; } = null;
}
