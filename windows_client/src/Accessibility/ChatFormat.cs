using System;
using SonicRoom.Windows.ViewModels;

namespace SonicRoom.Windows.Accessibility;

/// <summary>
/// Chat formatting, mirroring the web client's <c>client/src/lib/chat.ts</c> so a message
/// reads the same on both clients: "Alice: see you in 5 — sent 2 minutes ago". The format
/// here is the single source of truth for BOTH the transcript box and the spoken
/// announcement / Alt+number readback, so they never drift apart.
/// </summary>
public static class ChatFormat
{
    /// <summary>
    /// Separates a message from its trailing metadata (the "sent 2 minutes ago" time). A
    /// spaced em-dash so the two never run together when the text has no end punctuation —
    /// visually and as a pause for screen readers.
    /// </summary>
    public const string MetaSep = " — ";

    /// <summary>"just now" / "5 minutes ago" / "2 hours ago" / "3 days ago" — localized.</summary>
    public static string RelativeTime(DateTimeOffset ts, DateTimeOffset now)
    {
        var diff = now - ts; // positive = in the past
        var abs = diff.Duration();
        if (abs.TotalSeconds < 30) return I18n.T("time_just_now");
        string unitKey; long n;
        if (abs.TotalMinutes < 60) { n = (long)Math.Round(abs.TotalMinutes); unitKey = n == 1 ? "unit_minute" : "unit_minutes"; }
        else if (abs.TotalHours < 24) { n = (long)Math.Round(abs.TotalHours); unitKey = n == 1 ? "unit_hour" : "unit_hours"; }
        else { n = (long)Math.Round(abs.TotalDays); unitKey = n == 1 ? "unit_day" : "unit_days"; }
        var span = $"{n} {I18n.T(unitKey)}";
        return I18n.F(diff >= TimeSpan.Zero ? "time_ago" : "time_in", span); // future = clock skew
    }

    /// <summary>
    /// What "copy this message" puts on the clipboard: the message body only — no "sender:"
    /// prefix, no trailing "sent …" time. Event rows copy their event line.
    /// </summary>
    public static string MessageContent(ChatLine line) => line.Kind switch
    {
        ChatKind.Join => I18n.F("chat_joined", line.Sender),
        ChatKind.Leave => I18n.F("chat_left", line.Sender),
        _ => line.Text,
    };

    /// <summary>
    /// The full spoken/readback form, e.g. "Alice: hi — sent 2 minutes ago". Presence events
    /// read as "Alice joined — 2 minutes ago"; system events as their line plus the time.
    /// </summary>
    public static string FormatMessage(ChatLine line, DateTimeOffset now)
    {
        var time = RelativeTime(line.Ts, now);
        return line.Kind switch
        {
            ChatKind.Join => $"{I18n.F("chat_joined", line.Sender)}{MetaSep}{time}",
            ChatKind.Leave => $"{I18n.F("chat_left", line.Sender)}{MetaSep}{time}",
            ChatKind.System => $"{line.Text}{MetaSep}{time}",
            _ => $"{line.Sender}: {line.Text}{MetaSep}{I18n.F("chat_sent", time)}",
        };
    }

    /// <summary>One line of the visible transcript box (no relative time — it would go stale).</summary>
    public static string TranscriptLine(ChatLine line) => line.Kind switch
    {
        ChatKind.Join => $"* {I18n.F("chat_joined", line.Sender)}",
        ChatKind.Leave => $"* {I18n.F("chat_left", line.Sender)}",
        ChatKind.System => $"* {line.Text}",
        _ => $"{line.Sender}: {line.Text}",
    };
}
