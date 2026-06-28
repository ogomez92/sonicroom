// Client-side "who's talking" detection: cheaply measure which PEOPLE are talking
// by reading each incoming voice analyser's RMS, drive the per-peer "speaking" ring
// live, and keep a recent-talkers history the W / button readout announces. Works
// in both P2P and SFU (the server can't tell us who's talking in a 2-person room).
// Extracted from useMediasoup so the RMS + ring + hold logic are pure + testable.
import { useRoomStore } from "../../stores/room";
import type { PeerAudioRegistry } from "./peer-audio-registry";
import {
  announce_a_participant,
  announce_speakers_none,
  announce_speakers_list,
} from "../../paraglide/messages.js";

// We poll each incoming voice analyser this often and treat a peer as speaking once
// their short-term RMS crosses SPEAK_THRESHOLD; a brief hold keeps the flag (and the
// speaking ring) from flickering between words.
const SPEAK_POLL_MS = 120;
const SPEAK_THRESHOLD = 0.012; // RMS over the analyser window (~ -38 dBFS)
const SPEAK_HOLD_MS = 600; // stay "speaking" this long after dropping below
// How many recent talkers the W readout announces + numbers, and how long the
// numbered badges stay on their tiles.
const RECENT_SPEAKERS_MAX = 3;
const RECENT_SPEAKERS_KEEP = 12; // history kept (≥ MAX) so departures don't starve it
const SPEAKER_BADGE_MS = 3000;

// Root-mean-square of a time-domain buffer (the talk-level estimate).
export function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Push a talker to the front of the most-recent-first history (deduped, capped).
export function pushRecentSpeaker(list: string[], key: string, keep: number): string[] {
  const next = list.filter((p) => p !== key);
  next.unshift(key);
  return next.slice(0, keep);
}

// The hold/debounce transition: a peer is "speaking" while within holdMs of the
// last time their RMS crossed the threshold. Returns the (possibly updated) last-
// loud timestamp and the held on/off state.
export function nextSpeaking(
  rmsVal: number,
  lastLoudAt: number | undefined,
  now: number,
  threshold: number,
  holdMs: number,
): { loudAt: number | undefined; speaking: boolean } {
  const loudAt = rmsVal >= threshold ? now : lastLoudAt;
  return { loudAt, speaking: now - (loudAt ?? 0) < holdMs };
}

export class SpeakingDetector {
  // last time each voice peer was above threshold (for the hold)
  private readonly speakLoudAt = new Map<string, number>();
  // the debounced on/off we've pushed to the store
  private readonly speaking = new Map<string, boolean>();
  // most-recent-first talk history feeding the readout
  private recent: string[] = [];
  // a reused scratch buffer
  private buf: Float32Array<ArrayBuffer> | null = null;
  // clears the numbered badges a couple of seconds after the readout
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: typeof useRoomStore,
    private readonly registry: PeerAudioRegistry,
  ) {}

  // Start the poll loop; returns a cleanup that stops it + clears the badge timer.
  // The body is a no-op (zero analysers) until peers are consumed, so it's free in
  // the lobby.
  start(): () => void {
    const id = setInterval(() => this.poll(), SPEAK_POLL_MS);
    return () => {
      clearInterval(id);
      if (this.badgeTimer) clearTimeout(this.badgeTimer);
    };
  }

  private poll() {
    const peers = this.store.getState().peers;
    const now = Date.now();
    for (const [key, pa] of this.registry.peerAudios) {
      const ps = peers.get(key);
      // Only human voice tiles: music/share/file/extra-mic tiles are keyed
      // differently and carry isMusic/isMicStream.
      if (!ps || ps.isMusic || ps.isMicStream) continue;
      if (!this.buf || this.buf.length !== pa.analyser.fftSize) {
        this.buf = new Float32Array(pa.analyser.fftSize);
      }
      pa.analyser.getFloatTimeDomainData(this.buf);
      const { loudAt, speaking } = nextSpeaking(
        rms(this.buf),
        this.speakLoudAt.get(key),
        now,
        SPEAK_THRESHOLD,
        SPEAK_HOLD_MS,
      );
      if (loudAt !== undefined) this.speakLoudAt.set(key, loudAt);
      const was = this.speaking.get(key) ?? false;
      if (speaking === was) continue;
      this.speaking.set(key, speaking);
      this.store.getState().setPeerSpeaking(key, speaking);
      // On a rising edge, push this talker to the front of the recency list
      // (deduped, capped) — newest first, the order the readout numbers them.
      if (speaking) this.recent = pushRecentSpeaker(this.recent, key, RECENT_SPEAKERS_KEEP);
    }
    // Forget detection state for tiles that have gone away.
    for (const key of this.speaking.keys()) {
      if (!this.registry.peerAudios.has(key)) {
        this.speaking.delete(key);
        this.speakLoudAt.delete(key);
      }
    }
  }

  // Announce + briefly number (1, 2, 3) the most recent talkers — both the W
  // shortcut and the toolbar button call this. Transient (announce(), not
  // announceEvent): re-reads live state, so it is NOT logged to chat. Drops anyone
  // who has since left, caps to the top few, clears badges after a couple seconds.
  announceSpeakers() {
    const peers = this.store.getState().peers;
    const ids = this.recent.filter((peerId) => peers.has(peerId)).slice(0, RECENT_SPEAKERS_MAX);
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    if (ids.length === 0) {
      this.store.getState().setSpeakerBadges({});
      this.store.getState().announce(announce_speakers_none());
      return;
    }
    const badges: Record<string, number> = {};
    const names = ids.map((peerId, i) => {
      badges[peerId] = i + 1;
      return `${i + 1}. ${peers.get(peerId)?.displayName ?? announce_a_participant()}`;
    });
    this.store.getState().setSpeakerBadges(badges);
    this.store.getState().announce(announce_speakers_list({ names: names.join(", ") }));
    this.badgeTimer = setTimeout(() => {
      this.store.getState().setSpeakerBadges({});
      this.badgeTimer = null;
    }, SPEAKER_BADGE_MS);
  }
}
