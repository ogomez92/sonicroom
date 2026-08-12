# mediasoup ground truth (captured from sonic.gomsen.com, 2026-07-04)

Real values the native transport must interoperate with. Captured via
`tools/SignalingHarness ... probe`. Use these to build/verify the Phase 2 handshake.

## Router RTP capabilities (from `join` ack / `switch-to-sfu`)

- **Opus**: `mimeType: "audio/opus"`, `clockRate: 48000`, `channels: 2`,
  **`preferredPayloadType: 100`**.
  - `rtcpFeedback`: `nack`, `transport-cc`.
  - `parameters`: `useinbandfec:1, usedtx:0, maxplaybackrate:48000, maxaveragebitrate:256000, minptime:10, ptime:10`.
- **Audio header extensions** (uri → preferredId):
  - `urn:ietf:params:rtp-hdrext:sdes:mid` → **1**
  - `http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time` → 4
  - `http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01` (transport-cc) → 5 (audio: recvonly)
  - `urn:ietf:params:rtp-hdrext:ssrc-audio-level` → **6** (server ducking depends on this)
  - `http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time` → 10
  - `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay` → 11
  - `urn:mediasoup:params:rtp-hdrext:packet-id` → 12

## create-transport ack (send AND recv, identical shape)

```jsonc
{
  "ok": true,
  "params": {
    "id": "<uuid>",
    "iceParameters": {
      "usernameFragment": "<ufrag>",
      "password": "<pwd>",
      "iceLite": true, // server is ICE-LITE → client is controlling
    },
    "iceCandidates": [
      {
        "foundation": "udpcandidate",
        "priority": 1076302079,
        "ip": "217.154.98.41",
        "address": "217.154.98.41",
        "protocol": "udp",
        "port": 40042,
        "type": "host",
      },
      {
        "foundation": "udpcandidate",
        "priority": 1076276479,
        "ip": "2001:ba0:208:5400::1",
        "address": "2001:ba0:208:5400::1",
        "protocol": "udp",
        "port": 40034,
        "type": "host",
      },
    ],
    "dtlsParameters": {
      "fingerprints": [
        { "algorithm": "sha-1", "value": "96:30:AA:.." },
        { "algorithm": "sha-224", "value": ".." },
        { "algorithm": "sha-256", "value": "C3:09:F1:.." }, // prefer sha-256
        { "algorithm": "sha-384", "value": ".." },
        { "algorithm": "sha-512", "value": ".." },
      ],
      "role": "auto", // client chooses; we act as DTLS client (active)
    },
  },
}
```

Notes:

- UDP-only host candidates; no TCP/TLS (coturn handles fallback, not needed here on a server).
- The client never signals its own ICE candidates back — it connects to the server's candidates
  (ICE-lite). Only the client's **dtlsParameters** flow back via `connect-transport`.
- `produce` sends `{ kind:"audio", rtpParameters, source:"voice", title? }`; `consume` returns
  `{ consumerId, producerId, kind, rtpParameters }` (server-chosen PT/SSRC/mid).
