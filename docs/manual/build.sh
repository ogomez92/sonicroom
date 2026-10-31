#!/usr/bin/env bash
# Render the screen-reader manual (docs/manual/<lang>.md) to standalone HTML in
# client/public/manual/, which Vite copies verbatim into client/dist — so the
# pages are served by the server (and bundled by the Electron client) with no
# build step of their own. Requires pandoc; the generated HTML is committed, so
# nobody needs pandoc just to build or deploy the app.
#
# Usage: docs/manual/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../../client/public/manual"
mkdir -p "$out"

command -v pandoc >/dev/null || {
  echo "pandoc is not installed — see https://pandoc.org/installing.html" >&2
  exit 1
}

# Per-language chrome: the table-of-contents heading, the "back to the app" link
# and the switcher to the same manual in the other languages.
toc_title() {
  case "$1" in
    en) echo "Contents" ;;
    es) echo "Contenido" ;;
    fr) echo "Sommaire" ;;
    sk) echo "Obsah" ;;
  esac
}
back_label() {
  case "$1" in
    en) echo "Back to SonicRoom" ;;
    es) echo "Volver a SonicRoom" ;;
    fr) echo "Retour à SonicRoom" ;;
    sk) echo "Späť do SonicRoom" ;;
  esac
}
langs_label() {
  case "$1" in
    en) echo "Other languages:" ;;
    es) echo "Otros idiomas:" ;;
    fr) echo "Autres langues :" ;;
    sk) echo "Ďalšie jazyky:" ;;
  esac
}
nav_label() {
  case "$1" in
    en) echo "Manual navigation" ;;
    es) echo "Navegación del manual" ;;
    fr) echo "Navigation du manuel" ;;
    sk) echo "Navigácia v manuály" ;;
  esac
}
native_name() {
  case "$1" in
    en) echo "English" ;;
    es) echo "Español" ;;
    fr) echo "Français" ;;
    sk) echo "Slovenčina" ;;
  esac
}

ALL_LANGS=(en es fr sk)

for lang in "${ALL_LANGS[@]}"; do
  nav="$(mktemp)"
  {
    printf '<nav class="manual-nav" aria-label="%s">\n' "$(nav_label "$lang")"
    printf '  <a href="/">%s</a>\n' "$(back_label "$lang")"
    printf '  <span><strong>%s</strong>\n' "$(langs_label "$lang")"
    for other in "${ALL_LANGS[@]}"; do
      [ "$other" = "$lang" ] && continue
      printf '    <a href="./%s.html" hreflang="%s" lang="%s">%s</a>\n' \
        "$other" "$other" "$other" "$(native_name "$other")"
    done
    printf '  </span>\n</nav>\n'
  } >"$nav"

  pandoc "$here/$lang.md" \
    --from=markdown \
    --to=html5 \
    --standalone \
    --metadata "document-css=false" \
    --toc \
    --toc-depth=2 \
    --metadata "lang=$lang" \
    --variable "toc-title=$(toc_title "$lang")" \
    --include-in-header="$here/style.html" \
    --include-before-body="$nav" \
    --output="$out/$lang.html"

  rm -f "$nav"
  echo "built $out/$lang.html"
done
