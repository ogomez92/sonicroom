import type {
  WorkerSettings,
  RouterOptions,
  WebRtcTransportOptions,
  TransportListenInfo,
} from "mediasoup/types";
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

// ---------------------------------------------------------------------------
// Announced ICE addresses
// ---------------------------------------------------------------------------
//
// mediasoup announces ONE address per listenInfo, so "advertise several
// addresses" means "one listenInfo per address": the transport gathers a
// candidate for each and ICE picks whichever pair actually works.
//
// A single public IP is right for a VPS, but wrong for a box behind NAT. Peers
// on the same LAN as a home-hosted server usually cannot reach it via its
// public IP (most consumer routers don't hairpin NAT), so announcing only the
// public address leaves the people closest to the server unable to connect —
// while announcing only the LAN address locks out everyone off the LAN.
// Announcing both fixes it: LAN peers use the local candidate, the rest use the
// public one.
//
// So ANNOUNCED_IP / ANNOUNCED_IP6 accept a comma- (or space-) separated LIST,
// and ANNOUNCE_LOCAL_IPS=true appends this host's own non-loopback interface
// addresses so a home instance doesn't have to hardcode a DHCP-assigned LAN IP.
// A single value behaves exactly as it always did; an empty one keeps the old
// "announce whatever we bind" listenInfo.
//
// Cost of extra addresses: each listenInfo binds its own UDP port per
// transport, and every peer holds two transports (send + recv). Within the
// 40000-40100 worker range that caps concurrency at ~101 / (2 x addresses)
// peers, so announce the addresses you need rather than every address you have.

function parseAnnouncedAddresses(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/^\[|\]$/g, "")) // tolerate [2001:db8::1]
    .filter(Boolean);
}

/**
 * This host's own addresses for `family`, minus loopback and IPv6 link-local
 * (fe80::, which needs a scope id an ICE candidate can't carry). This is what
 * ANNOUNCE_LOCAL_IPS adds, so a home instance auto-announces its LAN address.
 */
export function localInterfaceAddresses(
  family: "IPv4" | "IPv6",
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): string[] {
  return Object.values(interfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((addr) => addr.family === family && !addr.internal)
    .map((addr) => addr.address)
    .filter((address) => !address.toLowerCase().startsWith("fe80:"));
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enable", "enabled"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

/** One UDP listenInfo per announced address, per IP family. */
export function buildListenInfos(
  env: NodeJS.ProcessEnv = process.env,
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): TransportListenInfo[] {
  const announceLocal = isTruthy(env.ANNOUNCE_LOCAL_IPS);
  const families = [
    {
      ip: "0.0.0.0",
      announced: [
        ...parseAnnouncedAddresses(env.ANNOUNCED_IP),
        ...(announceLocal ? localInterfaceAddresses("IPv4", interfaces) : []),
      ],
    },
    {
      ip: "::",
      announced: [
        ...parseAnnouncedAddresses(env.ANNOUNCED_IP6),
        ...(announceLocal ? localInterfaceAddresses("IPv6", interfaces) : []),
      ],
    },
  ];

  return families.flatMap<TransportListenInfo>(({ ip, announced }) => {
    const unique = [...new Set(announced)];
    // Nothing announced for this family: keep the historical single listenInfo
    // that announces whatever it binds (fine for localhost / LAN-only runs).
    if (unique.length === 0) return [{ protocol: "udp", ip }];
    return unique.map((announcedAddress) => ({ protocol: "udp", ip, announcedAddress }));
  });
}

/** The addresses handed to ICE, for the startup log. */
export function announcedAddresses(infos: TransportListenInfo[]): string[] {
  return infos.map((info) => info.announcedAddress).filter((a): a is string => Boolean(a));
}

export const transportOptions: WebRtcTransportOptions = {
  // UDP only. We deliberately don't advertise TCP ICE candidates: the firewall
  // only opens this range for UDP, and TCP fallback is already handled by the
  // shared coturn (TURN over 3478/tcp, TURNS over 5349/tls). Advertising
  // unreachable TCP candidates just made ICE slower (clients probed dead
  // candidates before relaying via coturn anyway).
  listenInfos: buildListenInfos(),
  initialAvailableOutgoingBitrate: 600000,
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
  iceConsentTimeout: 20,
};
