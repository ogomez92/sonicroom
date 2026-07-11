using System.ComponentModel;
using System.Runtime.CompilerServices;
using Microsoft.UI.Xaml;

namespace SonicRoom.Windows.ViewModels;

/// <summary>One row in the participant list. Bindable (INotifyPropertyChanged) for the WinUI list.</summary>
public sealed class PeerItem : INotifyPropertyChanged
{
    public string PeerId { get; }

    public PeerItem(string peerId, string displayName)
    {
        PeerId = peerId;
        _displayName = displayName;
    }

    private string _displayName;
    public string DisplayName
    {
        get => _displayName;
        set { _displayName = value; Raise(); RaiseLabels(); }
    }

    private bool _muted;
    public bool Muted
    {
        get => _muted;
        set { _muted = value; Raise(); Raise(nameof(MuteLabel)); Raise(nameof(RowLabel)); }
    }

    // UI-facing percentage. The audio session converts this to its existing 0-2 gain.
    // Exposing 0-200 with one-point steps makes keyboard and screen-reader operation
    // behave like a conventional Windows volume control while retaining 2x boost.
    private double _volumePercent = 100.0;
    public double VolumePercent
    {
        get => _volumePercent;
        set { _volumePercent = value; Raise(); }
    }

    /// <summary>Short status text shown next to the name ("muted" when the peer is muted).</summary>
    public string MuteLabel => _muted ? I18n.T("peer_muted_label") : "";

    /// <summary>Lights while this peer's voice is audibly active. Visual only — deliberately
    /// NOT part of <see cref="RowLabel"/> so screen readers aren't spammed by every word;
    /// the announce-speakers key (Ctrl+W) is the accessible query.</summary>
    private bool _isSpeaking;
    public bool IsSpeaking
    {
        get => _isSpeaking;
        set { if (_isSpeaking == value) return; _isSpeaking = value; Raise(); Raise(nameof(SpeakingGlyph)); }
    }

    public string SpeakingGlyph => _isSpeaking ? "●" : "";

    /// <summary>Client-side mute of this peer for MY ears only (their transmission continues).</summary>
    private bool _localMuted;
    public bool LocalMuted
    {
        get => _localMuted;
        set { _localMuted = value; Raise(); Raise(nameof(LocalMuteLabel)); }
    }

    public string LocalMuteLabel => I18n.F("local_mute_label", _displayName);

    private int _votes;
    public int Votes
    {
        get => _votes;
        set { _votes = value; Raise(); Raise(nameof(VoteLabel)); Raise(nameof(KickLabel)); Raise(nameof(RowLabel)); }
    }

    public string VoteLabel => _votes > 0 ? I18n.F("vote_label", _votes) : "";

    /// <summary>Whether I currently have a kick vote against this peer (server-confirmed).
    /// Backs the kick ToggleButton's pressed state — the UIA equivalent of aria-pressed.</summary>
    private bool _myVote;
    public bool MyVote
    {
        get => _myVote;
        set { _myVote = value; Raise(); }
    }

    /// <summary>Whether vote-to-kick applies right now (public room AND 3+ votable people —
    /// the same gate as the web client; the server enforces it authoritatively anyway).
    /// Drives the kick button's visibility so private/small rooms show no kick control.</summary>
    private bool _canKick;
    public bool CanKick
    {
        get => _canKick;
        set { _canKick = value; Raise(); Raise(nameof(KickVisibility)); }
    }

    /// <summary>A music caster (Ecobox). Casters are never vote-kickable (they're excluded from
    /// the votable count) but ANY peer can remove one outright via the caster button.</summary>
    private bool _isCaster;
    public bool IsCaster
    {
        get => _isCaster;
        set
        {
            if (_isCaster == value) return;
            _isCaster = value;
            Raise(); Raise(nameof(KickVisibility)); Raise(nameof(CasterVisibility)); Raise(nameof(RowLabel));
        }
    }

    /// <summary>Whether this peer currently sends any share/file/mic stream I could force-stop.</summary>
    private bool _hasStreams;
    public bool HasStreams
    {
        get => _hasStreams;
        set { if (_hasStreams == value) return; _hasStreams = value; Raise(); Raise(nameof(StopStreamVisibility)); }
    }

    public Visibility KickVisibility => _canKick && !_isCaster ? Visibility.Visible : Visibility.Collapsed;
    public Visibility CasterVisibility => _isCaster ? Visibility.Visible : Visibility.Collapsed;
    public Visibility StopStreamVisibility => _hasStreams ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>Accessible name for the per-peer volume slider.</summary>
    public string VolumeLabel => I18n.F("volume_label", _displayName);

    /// <summary>Accessible name for the kick button, carrying the running tally like the web
    /// client ("Kick Alice (2 votes)") so the state is audible without extra navigation.</summary>
    public string KickLabel => _votes > 0
        ? I18n.F("kick_label_votes", _displayName, _votes)
        : I18n.F("kick_label", _displayName);

    public string CasterLabel => I18n.F("remove_caster_label", _displayName);
    public string StopStreamLabel => I18n.F("stop_stream_label", _displayName);

    // Visible (localized) button texts for the row template.
    public string LocalMuteContent => I18n.T("local_mute_btn");
    public string StopStreamContent => I18n.T("stop_stream_btn");
    public string CasterContent => I18n.T("remove_caster_btn");
    public string KickContent => I18n.T("kick_btn");

    /// <summary>What the screen reader speaks for the whole list row: name + status. Also
    /// the ToString fallback, so the item NEVER reads as the CLR type name.</summary>
    public string RowLabel
    {
        get
        {
            var label = _displayName;
            if (_isCaster) label += ", " + I18n.T("caster_label");
            if (_muted) label += ", " + I18n.T("peer_muted_label");
            if (_votes > 0) label += ", " + I18n.F("row_votes", _votes);
            return label;
        }
    }

    public override string ToString() => RowLabel;

    /// <summary>Re-raise every derived label after a language switch so live rows re-render.</summary>
    public void RaiseLabels()
    {
        Raise(nameof(MuteLabel));
        Raise(nameof(LocalMuteLabel));
        Raise(nameof(VoteLabel));
        Raise(nameof(VolumeLabel));
        Raise(nameof(KickLabel));
        Raise(nameof(CasterLabel));
        Raise(nameof(StopStreamLabel));
        Raise(nameof(LocalMuteContent));
        Raise(nameof(StopStreamContent));
        Raise(nameof(CasterContent));
        Raise(nameof(KickContent));
        Raise(nameof(RowLabel));
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Raise([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
