using System.Text.RegularExpressions;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A source-shape guard for the GUI's route handlers.
///
/// Minimal APIs have a trap with no compiler error and no runtime exception: a handler whose first
/// parameter is <c>HttpContext</c> and whose body is an *expression* —
/// <c>async (HttpContext ctx) =&gt; Results.Json(...)</c> — also fits <c>RequestDelegate</c>
/// (<c>Func&lt;HttpContext, Task&gt;</c>). That is the more specific <c>MapGet</c> overload, so it wins,
/// the returned <c>IResult</c> is discarded, and the endpoint answers <b>200 with an empty body</b>. The
/// browser then sees valid-looking success carrying nothing.
///
/// This bit /api/status (silently, for some time), and again /api/livedata and /api/flow when their
/// bodies were factored out into shared builders. A statement body with an explicit <c>return</c> cannot
/// bind to <c>RequestDelegate</c>, so requiring one removes the whole failure mode.
/// </summary>
public class GuiRouteHandlerShapeTests
{
    /// <summary>
    /// Routes that are genuinely a <c>RequestDelegate</c>: they write the response themselves and return a
    /// plain <c>Task</c>, so they have nothing to discard.
    /// </summary>
    private static readonly HashSet<string> WritesItsOwnResponse = new() { "/api/events" };

    [Fact]
    public void RouteHandlersReturnTheirResults()
    {
        var source = File.ReadAllText(Path.Combine(FindRepoRoot(), "rPDU2MQTT.Web", "Gui", "GuiService.cs"));

        // Map*("<route>", [async] (HttpContext …) => …   — capture the route and what follows the arrow.
        var handlers = Regex.Matches(source,
            @"Map(?:Get|Post|Put|Delete)\(\s*""(?<route>[^""]+)""\s*,\s*(?:async\s+)?\(\s*HttpContext[^)]*\)\s*=>(?<body>[\s\S]{0,40})",
            RegexOptions.None, TimeSpan.FromSeconds(5));

        Assert.True(handlers.Count > 10, $"Expected to find the GUI's HttpContext route handlers; matched {handlers.Count}.");

        var offenders = handlers
            .Where(m => !WritesItsOwnResponse.Contains(m.Groups["route"].Value))
            .Where(m => !m.Groups["body"].Value.TrimStart().StartsWith('{'))
            .Select(m => m.Groups["route"].Value)
            .ToList();

        Assert.True(offenders.Count == 0,
            "These GUI endpoints take HttpContext but have an expression body, so ASP.NET Core binds them as a "
            + "RequestDelegate and throws the result away — they answer 200 with an empty body:\n    "
            + string.Join("\n    ", offenders)
            + "\n\nGive each a statement body with an explicit `return`:\n"
            + "    app.MapGet(\"/api/thing\", async (HttpContext ctx) =>\n"
            + "    {\n"
            + "        return Results.Json(await BuildThingAsync(ctx.RequestAborted), ConfigSchema.Json);\n"
            + "    });");
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Could not locate the repository root (no rPDU2MQTT.sln above the test output).");
    }
}
