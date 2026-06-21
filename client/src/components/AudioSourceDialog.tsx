import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronLeft, FileMusic, Folder, FolderOpen, Link, Music, X } from "lucide-react";
import { apiUrl } from "../lib/runtime-config";
import { m } from "../paraglide/messages.js";

interface AudioSourceDialogProps {
  onClose: () => void;
  onChooseComputerFile: () => void;
  onStartUrl: (url: string) => Promise<void>;
  // `relPath` may include subfolders, e.g. "Movies/Dune.mp3".
  onStartServerFile: (relPath: string) => Promise<void>;
}

interface LibraryEntry {
  name: string;
  dir: boolean;
}

export function AudioSourceDialog({
  onClose,
  onChooseComputerFile,
  onStartUrl,
  onStartServerFile,
}: AudioSourceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  // Set when a folder change should hand focus back to the list once it reloads.
  const focusListRef = useRef(false);
  const [url, setUrl] = useState("");
  // The server library is a browsable tree: `libPath` is the current folder
  // ("" = root) and `entries` are its folders + audio files. `activeIdx` is the
  // listbox's active option (roving via aria-activedescendant, like the lobby
  // room list and the chat list — a single tab stop, arrow/Home/End to move).
  const [libPath, setLibPath] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // Open as a real top-layer modal. Native <dialog> gives an inert background,
  // focus containment, and Escape-to-close; the explicit role="dialog" +
  // aria-modal below make it announce as a dialog on the screen readers that
  // don't convey a bare native <dialog> (and match every other modal here —
  // JoinRequests, FileStreamPlayer, the controls popovers). Initial focus ->
  // browse.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) dlg.showModal();
    browseRef.current?.focus();
    return () => dlg?.close();
  }, []);

  // (Re)list whenever the folder changes; reset the active option to the top.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetch(apiUrl(`/api/audio-library?path=${encodeURIComponent(libPath)}`))
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return (await res.json()) as { entries?: LibraryEntry[] };
      })
      .then(({ entries: next }) => {
        if (!active || !Array.isArray(next)) return;
        setEntries(next);
        setActiveIdx(next.length ? 0 : -1);
      })
      .catch(() => {
        // The library is optional and a folder may be unreadable — fall through
        // to the empty state. The `error` banner is reserved for an actual
        // failure to *start* a source.
        if (!active) return;
        setEntries([]);
        setActiveIdx(-1);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [libPath]);

  // After a folder change (Enter on a folder / Backspace / back button), move
  // focus back into the list so the first entry is read — or the back button if
  // the folder is empty.
  useEffect(() => {
    if (!focusListRef.current || loading) return;
    focusListRef.current = false;
    if (entries.length > 0) listRef.current?.focus();
    else (backRef.current ?? dialogRef.current)?.focus();
  }, [entries, loading]);

  // Keep the active option scrolled into view as it roves.
  useEffect(() => {
    if (activeIdx >= 0) optionRefs.current.get(activeIdx)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const start = async (action: () => Promise<void>) => {
    setStarting(true);
    setError("");
    try {
      await action();
      onClose();
    } catch {
      setError(m.audio_source_error());
      setStarting(false);
    }
  };

  const atRoot = libPath === "";
  const openFolder = (name: string) => {
    focusListRef.current = true;
    setLibPath((p) => (p ? `${p}/${name}` : name));
  };
  const goUp = () => {
    focusListRef.current = true;
    setLibPath((p) => p.split("/").slice(0, -1).join("/"));
  };
  const activateEntry = (entry: LibraryEntry) => {
    if (entry.dir) openFolder(entry.name);
    else if (!starting)
      void start(() => onStartServerFile(libPath ? `${libPath}/${entry.name}` : entry.name));
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (value) void start(() => onStartUrl(value));
  };

  // Listbox keyboard model, same as the lobby room list / chat list: arrow keys
  // and Home/End move the active option; Enter or Space activates it.
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (entries.length === 0) return;
    const last = entries.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min((i < 0 ? -1 : i) + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max((i < 0 ? entries.length : i) - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIdx(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIdx(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIdx >= 0 && entries[activeIdx]) activateEntry(entries[activeIdx]);
        break;
    }
  };

  // Backspace goes up a folder — but never while typing in the URL field.
  // (Escape is handled natively by the <dialog> via onCancel.)
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "Backspace" && !atRoot) {
      const target = e.target as HTMLElement;
      if (
        target.tagName !== "INPUT" &&
        target.tagName !== "TEXTAREA" &&
        !target.isContentEditable
      ) {
        e.preventDefault();
        goUp();
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-source-heading"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
      className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 text-sonic-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-center gap-2">
        <FileMusic className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
        <h2 id="audio-source-heading" className="text-base font-semibold text-sonic-100">
          {m.audio_source_heading()}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
          aria-label={m.audio_source_close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <button
        ref={browseRef}
        type="button"
        disabled={starting}
        onClick={onChooseComputerFile}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-700 px-3 py-2 text-sm font-medium text-sonic-100 hover:bg-sonic-600 disabled:opacity-50"
      >
        <FolderOpen className="h-4 w-4" />
        {m.audio_source_computer()}
      </button>

      <form onSubmit={submitUrl} className="mb-4">
        <label htmlFor="audio-source-url" className="mb-1 block text-xs font-medium text-sonic-300">
          {m.audio_source_url_label()}
        </label>
        <div className="flex gap-2">
          <input
            id="audio-source-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={m.audio_source_url_placeholder()}
            className="min-w-0 flex-1 rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={starting || !url.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-sonic-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Link className="h-4 w-4" />
            {m.audio_source_url_start()}
          </button>
        </div>
      </form>

      {/* Server library folder browser. The list is a single-tab-stop listbox
          (arrow keys / Home / End move the active row, Enter/Space activates);
          the back button or Backspace goes up a level. Names truncate via CSS
          while the full name stays in each option's aria-label. */}
      <div>
        <div className="mb-1 flex items-center gap-1.5">
          {!atRoot && (
            <button
              ref={backRef}
              type="button"
              onClick={goUp}
              aria-label={m.audio_source_back()}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <span
            id="audio-source-library-path"
            className="min-w-0 flex-1 truncate text-xs font-medium text-sonic-300"
            title={libPath || undefined}
          >
            {atRoot
              ? m.audio_source_library_label()
              : `${m.audio_source_library_label()} / ${libPath}`}
          </span>
        </div>

        {loading && entries.length === 0 ? (
          <p className="text-xs text-sonic-400">{m.audio_source_loading()}</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-sonic-400">
            {atRoot ? m.audio_source_library_empty() : m.audio_source_folder_empty()}
          </p>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-labelledby="audio-source-library-path"
            aria-activedescendant={activeIdx >= 0 ? `audio-source-opt-${activeIdx}` : undefined}
            onKeyDown={onListKeyDown}
            onFocus={() => setActiveIdx((i) => (i < 0 && entries.length ? 0 : i))}
            className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-sonic-600 bg-sonic-900/40 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
          >
            {entries.map((entry, i) => (
              <li
                key={`${entry.dir ? "d" : "f"}:${entry.name}`}
                id={`audio-source-opt-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                aria-label={
                  entry.dir
                    ? m.audio_source_open_folder({ name: entry.name })
                    : m.audio_source_stream_named({ name: entry.name })
                }
                ref={(el) => {
                  if (el) optionRefs.current.set(i, el);
                  else optionRefs.current.delete(i);
                }}
                onClick={() => activateEntry(entry)}
                title={entry.name}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-sonic-100 ${
                  i === activeIdx ? "bg-sonic-700" : "hover:bg-sonic-700/60"
                }`}
              >
                {entry.dir ? (
                  <Folder className="h-4 w-4 shrink-0 text-sonic-accent" aria-hidden="true" />
                ) : (
                  <Music className="h-4 w-4 shrink-0 text-sonic-300" aria-hidden="true" />
                )}
                <span className="truncate">{entry.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {error}
        </p>
      )}
    </dialog>
  );
}
