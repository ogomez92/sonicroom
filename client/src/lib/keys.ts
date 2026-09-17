// Platform-aware names for modifier keys in shortcut hints.
//
// The Alt+number readback and Alt+N are matched on the PHYSICAL key (e.code) in
// Room.tsx, so they already fire on a Mac — where the key is labelled Option
// and holding it changes what the letter keys type (Option+N is a dead key).
// What a Mac user reads or hears, though, must say "Option", not "Alt".
import * as m from "../paraglide/messages.js";

/** True on macOS / iPadOS, where the Alt key is labelled Option. */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): boolean {
  const p = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /\bMac|iPhone|iPad|iPod/.test(p);
}

/** The localized name of the Alt modifier on this platform ("Option" on a Mac). */
export function altKeyLabel(mac: boolean = isMacPlatform()): string {
  return mac ? m.key_option() : m.key_alt();
}
