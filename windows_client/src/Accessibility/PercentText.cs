using System;

namespace SonicRoom.Windows.Accessibility;

/// <summary>
/// The wording a percentage slider is announced with, as a PURE function so it can be unit-tested
/// without WinUI. The control (see <c>PercentSlider</c>) only puts this on the automation peer;
/// all the decisions live here, where they are testable in a plain test project.
///
/// WinUI 3 has no ValueText API (it was UWP), so this text is the only way a screen reader learns
/// the unit and the meaning of a value — it is worth getting right and worth testing.
/// </summary>
public static class PercentText
{
    /// <summary>
    /// The spoken name for a slider: the control's own accessible name, then the value and its
    /// unit, then — when the value sits at the normal level — the word that says so.
    ///
    /// The normal case is the one that matters: these sliders run 0–200 for a 0–2x gain, so 100 is
    /// the MIDDLE of the range, not the top. A bare "100 percent" reads like a maximum, and a
    /// screen-reader user has no way to tell the control is already where they want it.
    /// </summary>
    /// <param name="controlName">The slider's accessible name, without the unit ("Master volume").</param>
    /// <param name="value">Current value, rounded to a whole percent for speech.</param>
    /// <param name="unit">Unit word ("percent").</param>
    /// <param name="normalValue">The value meaning "unchanged" (100 for the 0–200 gain scales).</param>
    /// <param name="normalWord">Word spoken at that level ("normal"), supplied by i18n.</param>
    public static string Describe(string? controlName, double value, string unit = "percent",
                                  double normalValue = 100, string normalWord = "normal")
    {
        // With no configured name, the caller falls back to the framework's own name; here we
        // simply return nothing extra rather than inventing one.
        if (string.IsNullOrEmpty(controlName)) return string.Empty;

        var rounded = Math.Round(value);
        var text = $"{controlName}, {rounded:0} {unit}";
        if (rounded == Math.Round(normalValue)) text += $", {normalWord}";
        return text;
    }
}
