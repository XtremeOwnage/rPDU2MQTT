using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Operator;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Drives the operator's periodic update check. The operator throttles to Operator.CheckIntervalHours, so
/// this just needs to ask often enough; the GUI's "check now" / switch / redeploy call it directly.
/// </summary>
public sealed class OperatorUpdateCheck : BackgroundService
{
    private readonly IOperatorControl operatorControl;
    private readonly Config config;

    public OperatorUpdateCheck(IOperatorControl operatorControl, Config config)
    {
        this.operatorControl = operatorControl;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        do
        {
            if (config.Operator.Enabled && config.Operator.CheckForUpdates)
            {
                try { await operatorControl.CheckNow(force: false); }
                catch (Exception ex) { Serilog.Log.Debug($"Operator update check: {ex.Message}"); }
            }
        }
        while (await Core.Ticks.Next(timer, stoppingToken));
    }
}
