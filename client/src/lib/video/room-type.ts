// Room TYPE: audio call (the default, always) or video call. SonicRoom is
// audio-first, so a room is only a video room when the creator picked "Video
// call" in the lobby or the room URL carries `?video=on`. The flag is sticky
// server-side for the room's lifetime, and the client loads its video UI/media
// ONLY once the join response confirms `isVideo` — an audio room never renders,
// captures, or consumes any video.
export type RoomType = "audio" | "video";

// `?video=true` (also accepts on/yes/1/enable/enabled/video) makes the room a
// video call; `?video=off` (also false/no/0/disable/disabled) — or no param at
// all — keeps the audio default. Unknown values are treated as the default.
export function isVideoRoomParam(value: string | null): boolean {
  if (value == null) return false;
  return ["true", "on", "yes", "1", "enable", "enabled", "video"].includes(
    value.trim().toLowerCase(),
  );
}

export function roomTypeFromParam(value: string | null): RoomType {
  return isVideoRoomParam(value) ? "video" : "audio";
}
