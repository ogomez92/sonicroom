using SonicRoom.Windows.Accessibility;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// The wording a percentage slider is announced with.
///
/// The case that matters most is unity: these sliders run 0–200 for a 0–2x gain, so 100 is the
/// MIDDLE of the range, not the top. Announcing a bare "100 percent" reads like the maximum, and a
/// screen-reader user has no way to tell the control is already where they want it. It must say
/// "normal".
/// </summary>
public sealed class PercentTextTests
{
    private static string Describe(double value, string unit = "percent",
                                   double normalValue = 100, string normalWord = "normal")
        => PercentText.Describe("Master volume", value, unit, normalValue, normalWord);

    [Fact]
    public void OrdinaryValueCarriesItsUnit()
    {
        Assert.Equal("Master volume, 150 percent", Describe(150));
        Assert.Equal("Master volume, 50 percent", Describe(50));
        Assert.Equal("Master volume, 0 percent", Describe(0));
    }

    [Fact]
    public void UnityIsAnnouncedAsNormalNotAsAMaximum()
    {
        Assert.Equal("Master volume, 100 percent, normal", Describe(100));
    }

    [Fact]
    public void BoostAndCutAreNotCalledNormal()
    {
        Assert.DoesNotContain("normal", Describe(150));
        Assert.DoesNotContain("normal", Describe(50));
        Assert.DoesNotContain("normal", Describe(0));
        Assert.DoesNotContain("normal", Describe(200));
    }

    [Fact]
    public void RoundingIsToWholePercent()
    {
        Assert.Equal("Master volume, 33 percent", Describe(33.4));
        Assert.Equal("Master volume, 34 percent", Describe(33.5));
    }

    [Fact]
    public void CustomUnitAndNormalWordAreUsed()
    {
        // The normal word comes from i18n, so it must be a parameter, not a hard-coded literal.
        Assert.Equal("Master volume, 100 decibels, sin cambios",
            Describe(100, unit: "decibels", normalWord: "sin cambios"));
    }

    [Fact]
    public void ANormalValueOtherThan100IsHonoured()
    {
        Assert.DoesNotContain("normal", Describe(100, normalValue: 200));
        Assert.Contains("normal", Describe(200, normalValue: 200));
    }

    [Fact]
    public void NoControlNameMeansNoInventedName()
    {
        // The control falls back to the framework's own name in that case; Describe adds nothing.
        Assert.Equal(string.Empty, PercentText.Describe(null, 100));
        Assert.Equal(string.Empty, PercentText.Describe("", 100));
    }
}
