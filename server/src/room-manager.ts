import type {
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  Worker,
  AudioLevelObserver,
} from "mediasoup/types";
import { routerOptions, transportOptions } from "./mediasoup-config.js";
import type { ChatMessage } from "./chat-util.js";

export interface Peer {
  id: string;
  displayName: string;
  // Best-effort client IP (see clientIp in signaling). Kept so a vote-to-kick
  // can room-ban it on removal, the same soft ban a knock-deny applies.
  ip: string;
  // Mirrors the client's mute toggle (set via producer-pause/-resume, which
  // fire in P2P mode too) so late joiners can render existing peers' state.
  muted: boolean;
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export type RoomMode = "p2p" | "sfu";

export interface Room {
  name: string;
  router: Router;
  peers: Map<string, Peer>;
  mode: RoomMode;
  // P2P explicitly disabled for this room (via the `?p2p=off` room URL param).
  // Pins the room to the SFU even with <=2 peers; sticky for the room's
  // lifetime once any joiner sets it (see decideMode's forceSfu).
  disableP2p: boolean;
  // Room TYPE: a VIDEO call (the lobby's "Video call" room type / `?video=on`).
  // SonicRoom is audio-first, so this is off by default and sticky for the
  // room's lifetime once any joiner sets it. A video room is pinned to the SFU
  // (video never rides the P2P mesh — camera/screen tracks are separate
  // "camera"/"screen" producers, like share/file), and the produce handler
  // REJECTS any video producer unless this flag is set, so an audio room can
  // never carry video. Clients read it from the join response and only then
  // load their video UI.
  isVideo: boolean;
  // Whether this room is publicly listed in the lobby (via the "Make this room
  // public" toggle / `?public=true` URL param). Private by default; sticky for
  // the room's lifetime once any joiner sets it. Listed by getPublicRooms.
  isPublic: boolean;
  // "Ask to join" (knock) state for a PUBLIC room: a visitor to an already-
  // public, occupied room is held here (keyed by their socket id) until someone
  // inside allows or denies them. Participants are shown a modal + hear a knock
  // loop while this is non-empty. Always empty for private rooms. `ip` is kept
  // so a deny can ban it (see bannedIps).
  pendingJoins: Map<string, { displayName: string; token: string; ip: string }>;
  // Per-session join tokens already admitted to this room, so an admitted
  // participant can reconnect/refresh without re-knocking. Sticky for the
  // room's lifetime.
  admittedTokens: Set<string>;
  // Display names that have been admitted to this room (and not since denied),
  // so someone who was let in earlier — then left — is auto-admitted if they
  // come back under the same name instead of having to knock again. A denial
  // removes the name (see join-decision). Soft, name-based, like bannedIps;
  // sticky for the room's lifetime.
  admittedNames: Set<string>;
  // Client IPs banned from this room because a participant denied their knock.
  // Checked on every join attempt to this room and refused outright (no knock).
  // Room-scoped and for the room's lifetime only (cleared when the room dies).
  bannedIps: Set<string>;
  // Peer ids of send-only "music caster" peers (e.g. Ecobox). While any are
  // present the room is forced to SFU (see decideMode's forceSfu).
  casters: Set<string>;
  // Peer ids currently sharing system/tab audio. Their share is a *separate*
  // stereo "share" producer (the voice track stays mono), which the server has
  // to route — so an active sharer forces SFU just like a caster does.
  sharers: Set<string>;
  // Peer ids currently streaming a local file into the call. Like a share, a
  // file stream is its own *separate* stereo "file" producer (independent of the
  // voice track AND of any audio share), so the server has to route it — an
  // active file streamer forces SFU just like a caster/sharer does.
  fileStreamers: Set<string>;
  // Peer ids currently streaming one or more EXTRA microphone/input devices.
  // Each extra mic is its own *separate* "mic" producer (in addition to the
  // peer's voice producer), so the server has to route it — an active extra-mic
  // streamer forces SFU just like a caster/sharer/file-streamer does. A peer is
  // in this set while it has >=1 live "mic" producer.
  extraMicStreamers: Set<string>;
  // Watches VOICE producers only (music producers are never added) to drive
  // auto-ducking: when someone talks, listeners lower the music peer's volume.
  audioLevelObserver: AudioLevelObserver;
  // Latched ducking state so we only broadcast on transitions, and whether the
  // observer's events have been wired (done once per room in signaling).
  voiceActive: boolean;
  observerWired: boolean;
  // Room-wide auto-ducking toggle (default on). When off, listeners stop
  // ducking ALL music-type streams (caster, share, file) entirely — the level
  // observer keeps running, but clients ignore the duck signal (gated in
  // effectiveGain). Synced via the join response + a `ducking-changed`
  // broadcast; persists for the room's lifetime.
  duckingEnabled: boolean;
  // Vote-to-kick tallies for a PUBLIC room (no moderators): target peerId ->
  // the set of peerids who've voted to remove them. When a target's set reaches
  // kickThreshold(votable peers) it's removed. A target's entry is cleared on
  // kick; a voter's votes are dropped when they leave (see cleanupKickVotes).
  // Only ever populated for public rooms.
  kickVotes: Map<string, Set<string>>;
  // Rolling chat history (bounded to CHAT_HISTORY_MAX) so late joiners receive
  // recent messages on join. Newest last.
  messages: ChatMessage[];
  // Shared collaborative note for this room (a NoteLab edit-link URL), or null
  // until someone first opens the "Notes" button / Alt+N. Created once and then
  // reused by everyone for the room's lifetime; lives and dies with the room.
  // See notes.ts. Always null when the feature is unconfigured (no NOTELAB_URL).
  notesUrl: string | null;
}

const rooms = new Map<string, Room>();

let workers: Worker[] = [];
let workerIdx = 0;

export function setWorkers(w: Worker[]) {
  workers = w;
}

function getNextWorker(): Worker {
  const worker = workers[workerIdx % workers.length];
  workerIdx++;
  return worker;
}

export async function getOrCreateRoom(roomName: string): Promise<Room> {
  const existing = rooms.get(roomName);
  if (existing) return existing;

  const worker = getNextWorker();
  const router = await worker.createRouter(routerOptions);

  // -50 dBov ignores room/keyboard noise but catches normal speech; a short
  // interval keeps ducking responsive. Closed automatically with the router.
  const audioLevelObserver = await router.createAudioLevelObserver({
    maxEntries: 1,
    threshold: -50,
    interval: 300,
  });

  const room: Room = {
    name: roomName,
    router,
    peers: new Map(),
    mode: "p2p",
    disableP2p: false,
    isVideo: false,
    isPublic: false,
    pendingJoins: new Map(),
    admittedTokens: new Set(),
    admittedNames: new Set(),
    bannedIps: new Set(),
    casters: new Set(),
    sharers: new Set(),
    fileStreamers: new Set(),
    extraMicStreamers: new Set(),
    audioLevelObserver,
    voiceActive: false,
    observerWired: false,
    duckingEnabled: true,
    kickVotes: new Map(),
    messages: [],
    notesUrl: null,
  };
  rooms.set(roomName, room);
  return room;
}

export function createPeer(room: Room, peerId: string, displayName: string, ip: string): Peer {
  const peer: Peer = {
    id: peerId,
    displayName,
    ip,
    muted: false,
    sendTransport: null,
    recvTransport: null,
    producers: new Map(),
    consumers: new Map(),
  };
  room.peers.set(peerId, peer);
  return peer;
}

export async function createWebRtcTransport(room: Room) {
  const transport = await room.router.createWebRtcTransport(transportOptions);

  // Reduce latency: set max incoming bitrate
  await transport.setMaxIncomingBitrate(1500000);

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

export function removePeer(room: Room, peerId: string) {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  // Close all transports (this also closes producers/consumers)
  peer.sendTransport?.close();
  peer.recvTransport?.close();

  room.peers.delete(peerId);

  // If room is empty, destroy it
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.name);
  }
}

export function getRooms() {
  return rooms;
}

// Occupancy of ONE room by name, or null if no such room is live. Rooms only
// exist while they hold at least one peer (removePeer destroys an empty one),
// so "the room exists" is the same statement as "someone is in it" — there is
// no such thing as a live-but-empty room to report a count of 0 for.
// `participants` counts every peer, `casters` the send-only music sources among
// them, so `participants - casters` is the number of humans. Names are
// deliberately NOT included: for a public room they're already in
// getPublicRooms, and for a private one the count is all this should reveal.
export function getRoomInfo(roomName: string): {
  name: string;
  participants: number;
  casters: number;
  isPublic: boolean;
  isVideo: boolean;
  mode: RoomMode;
} | null {
  const room = rooms.get(roomName);
  if (!room) return null;
  return {
    name: room.name,
    participants: room.peers.size,
    casters: room.casters.size,
    isPublic: room.isPublic,
    isVideo: room.isVideo,
    mode: room.mode,
  };
}

// Snapshot of the currently-live PUBLIC rooms for the lobby list: each room's
// name plus the display names of everyone currently in it. Private rooms are
// omitted entirely. Rooms only exist while they hold at least one peer, so
// `participants` is never empty. `isVideo` lets the lobby flag video rooms so a
// visitor knows a camera may be expected before they walk in.
export function getPublicRooms(): { name: string; participants: string[]; isVideo: boolean }[] {
  const out: { name: string; participants: string[]; isVideo: boolean }[] = [];
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    out.push({
      name: room.name,
      participants: Array.from(room.peers.values()).map((p) => p.displayName),
      isVideo: room.isVideo,
    });
  }
  return out;
}
