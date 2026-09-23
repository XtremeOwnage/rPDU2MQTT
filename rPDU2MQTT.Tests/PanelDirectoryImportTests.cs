using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Reading a panel directory as people keep them (#455): the parts a line carries, in any order.</summary>
public class PanelDirectoryImportTests
{
    /// <summary>The example from the issue: every shape of line one real directory mixes.</summary>
    private const string Pasted = """
        Iotawatt: 1
        1,3: AC Heat Strips
        2,4: Dryer
        B06,W11,N30,1,5: Lights, Garage, Kitchen
        B07,W02,N30,2,10:
        B24: W20: Master Bedroom Outlets
        B25: Office, N30,1,2
        B26.1: W21: N utility room. Servers
        B26.2: W22: Unused
        B09: Bathroom Lights????
        """;

    private static DirectoryRow Row(string number) => PanelDirectoryImport.Parse(Pasted).First(r => r.Number == number);

    [Fact]
    public void ADoublePoleBreakerIsReadFromTheSlotsItHolds()
    {
        var r = Row("1,3");

        Assert.Equal(1, r.Slot);
        Assert.Equal(2, r.Poles);
        Assert.Equal("AC Heat Strips", r.Description);
        Assert.Equal(BreakerState.Identified, r.State);
    }

    [Fact]
    public void ALineCarryingNumberWireAndChannel_IsReadWhole()
    {
        var r = Row("B06");

        Assert.Equal(6, r.Slot);
        Assert.Equal("W11", r.Wire);
        Assert.Equal("n30_1_5", r.Channel);
        Assert.Equal("Lights, Garage, Kitchen", r.Description);
    }

    [Fact]
    public void ABreakerWithNothingWrittenAgainstIt_IsNotIdentified()
    {
        var r = Row("B07");

        Assert.Equal("n30_2_10", r.Channel);
        Assert.Equal("", r.Description);
        Assert.Equal(BreakerState.Unknown, r.State);
    }

    [Fact]
    public void PartsSeparatedByColons_AreReadTheSameWay()
    {
        var r = Row("B24");

        Assert.Equal("W20", r.Wire);
        Assert.Equal("Master Bedroom Outlets", r.Description);
    }

    [Fact]
    public void AChannelWrittenAmongTheWords_IsPickedOutOfThem()
    {
        var r = Row("B25");

        Assert.Equal("n30_1_2", r.Channel);
        Assert.Equal("Office", r.Description);
    }

    [Fact]
    public void ATandemHalfKeepsWhichHalfItIs()
    {
        var upper = Row("B26.1");
        var lower = Row("B26.2");

        Assert.Equal(26, upper.Slot);
        Assert.Equal(1, upper.Half);
        Assert.Equal("W21", upper.Wire);
        Assert.Equal("N utility room. Servers", upper.Description);
        // "Unused" is the directory's own word for an empty one.
        Assert.Equal(2, lower.Half);
        Assert.Equal(BreakerState.Unused, lower.State);
        Assert.Equal("", lower.Description);
    }

    [Fact]
    public void TheDirectorysOwnQuestionMarks_MarkItUnidentified()
    {
        var r = Row("B09");

        Assert.Equal(BreakerState.Unknown, r.State);
        Assert.Equal("Bathroom Lights", r.Description);   // what someone guessed is kept; the mark is not
    }

    [Fact]
    public void ALineThatIsNotABreaker_IsKeptWithWhy()
    {
        var bad = PanelDirectoryImport.Parse(Pasted).First(r => !r.Ok);

        Assert.Equal("Iotawatt: 1", bad.Line);
        Assert.Contains("does not read as a breaker number", bad.Note);
    }

    [Fact]
    public void ARatingOnTheLineIsRead()
    {
        var r = PanelDirectoryImport.ParseLine("B12,20A,W14: Hall lights");

        Assert.Equal(20, r.Amps);
        Assert.Equal("W14", r.Wire);
        Assert.Equal("Hall lights", r.Description);
    }

    [Fact]
    public void ImportingSaysWhatEachLineWouldDoToThePanel()
    {
        var panel = new PanelConfig { Id = "main", Breakers = { new BreakerConfig { Slot = 6, Number = "B06", Description = "old" }, new BreakerConfig { Slot = 24, Number = "B24" } } };

        Assert.Equal("update", PanelDirectoryImport.Effect(panel, Row("B06")));
        Assert.Equal("add", PanelDirectoryImport.Effect(panel, Row("B25")));
        // A slot already held by a differently-numbered breaker is a clash, not a silent overwrite.
        Assert.Equal("clash", PanelDirectoryImport.Effect(panel, PanelDirectoryImport.ParseLine("24: Something else")));
    }
}
