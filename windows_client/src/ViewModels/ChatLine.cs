using System;

namespace SonicRoom.Windows.ViewModels;

/// <summary>
/// What kind of chat-timeline entry this is. Mirrors the web client: the chat history is
/// the single timeline of everything announced — normal messages plus join/leave presence
/// and "system" room events (recording started, peer kicked, …) — so the Alt+number
/// readback covers events too.
/// </summary>
public enum ChatKind { Message, Join, Leave, System }

/// <summary>One chat-timeline entry. Join/Leave use Sender as the participant name and
/// ignore Text; System carries the event line in Text and ignores Sender.</summary>
public sealed record ChatLine(string Sender, string Text, DateTimeOffset Ts, ChatKind Kind = ChatKind.Message);
