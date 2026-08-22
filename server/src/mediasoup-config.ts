import type { WorkerSettings, RouterOptions, WebRtcTransportOptions } from "mediasoup/types";
import os from "node:os";

const numCores = os.cpus().length;

export const workerSettings: WorkerSettings = {
  logLevel: "warn",
  rtcMinPort: 40000,
  rtcMaxPort: 40100,
};

export const numWorkers = Math.max(1, numCores);

export const routerOptions: RouterOptions = {
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,
        usedtx: 0,
        maxplaybackrate: 48000,
        // This is a ceiling, not a floor. Voice producers cap themselves well
        // below it — mono 64k by default, or the per-user hi-fi opt-in's stereo
        // 128k (client `forceOpusParams` / produce `opusStereo` +
        // `opusMaxAverageBitrate`) — so the router ceiling does NOT make voice
        // balloon. It only lets the dedicated stereo "music caster" (Ecobox),
        // share, and file producers negotiate up to a hi-fi bitrate. Do not
        // lower this back to 64000 — that would silently clamp the music stream
        // to voice quality.
        maxaveragebitrate: 256000,
        minptime: 10,
        ptime: 10,
      },
    },
    // Video is only ever produced in a VIDEO room (room.isVideo — the produce
    // handler rejects video elsewhere). VP8 is the universal WebRTC baseline
    // (every browser, software-encodable everywhere), which matters more here
    // than H.264's hardware paths; the start-bitrate hint keeps the first
    // seconds from looking like a slideshow before BWE ramps.
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
      parameters: { "x-google-start-bitrate": 800 },
    },
  ],
};

export const transportOptions: WebRtcTransportOptions = {
  // UDP only. We deliberately don't advertise TCP ICE candidates: the firewall
  // only opens this range for UDP, and TCP fallback is already handled by the
  // shared coturn (TURN over 3478/tcp, TURNS over 5349/tls). Advertising
  // unreachable TCP candidates just made ICE slower (clients probed dead
  // candidates before relaying via coturn anyway).
  listenInfos: [
    {
      protocol: "udp",
      ip: "0.0.0.0",
      announcedAddress: process.env.ANNOUNCED_IP || undefined,
    },
    {
      protocol: "udp",
      ip: "::",
      announcedAddress: process.env.ANNOUNCED_IP6 || undefined,
    },
  ],
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  iceConsentTimeout: 20,
};
