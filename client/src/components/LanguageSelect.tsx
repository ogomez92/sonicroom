import { Languages } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { locales, LOCALE_NAMES, type Locale } from "../lib/i18n";
import { m } from "../paraglide/messages.js";

// Language picker used in the Lobby and the Room header. Switching applies
// immediately and in place (no reload), so it's safe even during an active call.
export function LanguageSelect({ className = "" }: { className?: string }) {
  const locale = useRoomStore((s) => s.locale);
  const setLanguage = useRoomStore((s) => s.setLanguage);

  return (
    <label className={`flex items-center gap-1.5 ${className}`}>
      <Languages className="h-4 w-4 text-sonic-400" aria-hidden="true" />
      <span className="sr-only">{m.language_label()}</span>
      <select
        value={locale}
        onChange={(e) => setLanguage(e.target.value as Locale)}
        aria-label={m.language_label()}
        className="cursor-pointer rounded-md border border-sonic-600 bg-sonic-700 px-2 py-1 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
      >
        {locales.map((l) => (
          // Each name is in its own language (LOCALE_NAMES): tag it so a screen
          // reader says "Español" with a Spanish voice, not an English one.
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
