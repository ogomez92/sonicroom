// App-wide locale wiring on top of Paraglide's generated runtime.
//
// Resolution order (configured in vite.config.ts): the user's stored choice
// (language picker) → the browser's preferred language → English. On top of
// that, a `?lang=` URL param (e.g. shared on a room link alongside `?p2p=off`)
// wins and is applied here, once, before anything reads the locale.
import { getLocale, setLocale, isLocale, locales, baseLocale } from "../paraglide/runtime.js";

// "en" | "es" | "fr", derived from the generated `locales` tuple.
export type Locale = (typeof locales)[number];

// Native names for the picker — each language shown in its own language.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  sk: "Slovenčina",
};

// Apply a `?lang=` override up front. reload:false because React re-renders in
// place when the store's `locale` changes (see main.tsx) — so even applying
// this mid-call wouldn't drop the connection. setLocale also persists it
// (localStorage strategy), so the link recipient keeps that language.
const urlLang = new URLSearchParams(window.location.search).get("lang");
if (urlLang && isLocale(urlLang) && urlLang !== getLocale()) {
  setLocale(urlLang, { reload: false });
}

// Keep <html lang> correct from the first paint (a11y, hyphenation, SEO).
document.documentElement.lang = getLocale();

export { getLocale, setLocale, isLocale, locales, baseLocale };
