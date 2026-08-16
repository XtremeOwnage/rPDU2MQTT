namespace rPDU2MQTT.Grains.Abstractions.Status;

/// <summary>
/// The Status board card for an integration that has no bespoke grain of its own — every externally loaded
/// plugin, and any built-in that never needed special verdict rules.
///
/// <para>
/// Keyed by the integration's id. The five hand-written component grains stay as they are: each encodes a
/// real judgement about its own subject ("only the exporting process has an outcome to report, so an
/// outcome-free report must not overwrite a known one"), and replacing that with a generic rule would lose
/// the reasoning rather than share it. This exists because a plugin previously appeared on the board not at
/// all — which is indistinguishable from one that failed to load.
/// </para>
/// </summary>
public interface IIntegrationStatusGrain : IComponentStatusGrain
{
}
