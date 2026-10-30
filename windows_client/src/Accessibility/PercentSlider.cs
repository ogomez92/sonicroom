using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace SonicRoom.Windows.Accessibility;

/// <summary>
/// A percentage slider a screen reader announces with its unit AND its meaning, e.g.
/// "Master volume, 150 percent" or "Master volume, 100 percent, normal".
///
/// WinUI 3 has no <c>AutomationProperties.SetValueText</c>/<c>ValueText</c> — those were UWP APIs
/// and this compiler rejects them — so the text has to arrive through the automation peer's name.
/// This control exists so every slider gets it uniformly, including the per-peer volume slider
/// inside the participant row template, which XAML creates with no code-behind hook.
///
/// Give the slider an accessible name WITHOUT the unit ("Master volume"); the wording is built by
/// <see cref="PercentText"/>, which is where the decisions (and their tests) live.
/// </summary>
public sealed class PercentSlider : Slider
{
    /// <summary>Unit spoken after the value ("percent", by default).</summary>
    public string Unit { get; set; } = "percent";

    /// <summary>The value meaning "unchanged" (100 for the 0–200 gain scales), announced as the
    /// normal level so the user knows the control is already where they want it.</summary>
    public double NormalValue { get; set; } = 100.0;

    /// <summary>Word spoken for the normal level; supplied by i18n.</summary>
    public string NormalWord { get; set; } = "normal";

    protected override AutomationPeer OnCreateAutomationPeer() => new PercentSliderPeer(this);
}

internal sealed class PercentSliderPeer : SliderAutomationPeer
{
    private readonly PercentSlider _slider;

    public PercentSliderPeer(PercentSlider owner) : base(owner) => _slider = owner;

    protected override string GetNameCore()
    {
        var spoken = PercentText.Describe(
            AutomationProperties.GetName(_slider), _slider.Value,
            _slider.Unit, _slider.NormalValue, _slider.NormalWord);
        return spoken.Length == 0 ? base.GetNameCore() : spoken;
    }
}
