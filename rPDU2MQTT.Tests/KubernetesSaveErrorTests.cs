using rPDU2MQTT.Startup.ConfigSources;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What a rejected save tells the operator. The API server's Status object pasted into a toast is a wall of
/// escaped JSON that hides the one field at fault, and the commonest cause — a CRD older than the build
/// writing to it — reads as the GUI being broken when the fix is to apply the CRD.
/// </summary>
public class KubernetesSaveErrorTests
{
    // Verbatim, from a save of an import profile mapping a measure to energy_d against a CRD predating it.
    private const string CrdTooOld = """
    {"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"RpduConfig.rpdu2mqtt.xtremeownage.com \"rpdu2mqtt\" is invalid: spec.MQTT.ImportProfiles[0].Metrics.energy_d: Unsupported value: \"energy_d\": supported values: \"realpower\", \"apparentpower\", \"energy\", \"current\", \"voltage\", \"frequency\", \"powerfactor\", \"soc\"","reason":"Invalid","details":{"name":"rpdu2mqtt","group":"rpdu2mqtt.xtremeownage.com","kind":"RpduConfig","causes":[{"reason":"FieldValueNotSupported","message":"Unsupported value: \"energy_d\": supported values: \"realpower\", \"apparentpower\", \"energy\", \"current\", \"voltage\", \"frequency\", \"powerfactor\", \"soc\"","field":"spec.MQTT.ImportProfiles[0].Metrics.energy_d"}]}, "code":422}
    """;

    [Fact]
    public void AValueTheInstalledCrdDoesNotKnow_NamesTheField_TheValue_AndWhatToDo()
    {
        var text = KubernetesSaveError.Explain(422, CrdTooOld)!;

        // The setting, as the GUI shows it — 'spec.' is the CR's wrapper, not part of the path.
        Assert.Contains("MQTT.ImportProfiles[0].Metrics.energy_d", text);
        Assert.DoesNotContain("spec.MQTT", text);
        // The value at fault and what the cluster would take instead, without the quoting.
        Assert.Contains("'energy_d' is not a value the installed CRD allows here", text);
        Assert.Contains("it accepts realpower, apparentpower, energy", text);
        // And the fix, which is not "try again".
        Assert.Contains("CRD in the cluster is older than this build", text);
        Assert.Contains("kubectl apply", text);
        // None of the raw Status object survives.
        Assert.DoesNotContain("\\\"", text);
        Assert.DoesNotContain("apiVersion", text);
    }

    [Fact]
    public void ARejectionWithNoCauses_StillReportsWhatTheServerSaid()
    {
        var body = """{"kind":"Status","status":"Failure","message":"admission webhook denied the request","code":403}""";

        var text = KubernetesSaveError.Explain(403, body)!;

        Assert.Contains("HTTP 403", text);
        Assert.Contains("admission webhook denied the request", text);
        // Nothing about the CRD: this was not a schema rejection.
        Assert.DoesNotContain("kubectl apply", text);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("""{"kind":"Pod"}""")]
    public void AnythingThatIsNotAnApiServerRejection_IsLeftToTheCaller(string body)
        => Assert.Null(KubernetesSaveError.Explain(500, body));
}
