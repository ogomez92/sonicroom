import { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { useRoomStore, type ChatAnnounceMode } from "../stores/room";
import { relativeTime, messageContent, META_SEP } from "../lib/chat";
import { warmUpTts } from "../lib/tts";
import { m } from "../paraglide/messages.js";

interface ChatProps {
  // Returns ok:false with a reason when nothing was sent, so we keep the text
  // in the box (the hook already played the "thunk" cue for rate_limited).
  onSend: (text: string) => Promise<{ ok: boolean; reason?: "empty" | "rate_limited" }>;
  onClose: () => void;
  // Changes whenever the caller wants the composer (re)focused even though the
  // panel is already open — e.g. handing focus back after the join modal closes.
  focusSignal?: number;
}

// In-room chat. Order matters for accessibility: the message list (a listbox
// you arrow through) comes BEFORE the composer, so screen-reader users land on
// history first. New messages are announced and chimed elsewhere (the hook);
// this panel is just the visible list + editor.
export function Chat({ onSend, onClose, focusSignal }: ChatProps) {
  const messages = useRoomStore((s) => s.messages);
  const announce = useRoomStore((s) => s.announce);
  const chatAnnounceMode = useRoomStore((s) => s.chatAnnounceMode);
  const setChatAnnounceMode = useRoomStore((s) => s.setChatAnnounceMode);
  const [text, setText] = useState("");
  // Active listbox option (roving via aria-activedescendant). -1 = none yet.
  const [activeIdx, setActiveIdx] = useState(-1);
  // Ticks so "x minutes ago" stays roughly fresh without per-message timers.
  const [now, setNow] = useState(() => Date.now());

  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Drop focus into the composer when the panel opens, and again whenever the
  // caller bumps focusSignal (e.g. the join modal just closed).
  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusSignal]);

  // Keep the active option valid as messages arrive or clear.
  useEffect(() => {
    setActiveIdx((i) => (i < 0 ? -1 : Math.min(i, messages.length - 1)));
  }, [messages.length]);

  // While navigating, keep the active option visible; otherwise pin the newest.
  useEffect(() => {
    if (activeIdx >= 0 && messages[activeIdx]) {
      optionRefs.current.get(messages[activeIdx].id)?.scrollIntoView({ block: "nearest" });
    } else if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [activeIdx, messages]);

  const activeId =
    activeIdx >= 0 && messages[activeIdx] ? `chat-opt-${messages[activeIdx].id}` : undefined;

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (messages.length === 0) return;
    const last = messages.length - 1;

    // Ctrl/Cmd+C copies the focused message's content. A manual mouse selection
    // takes precedence — let the browser copy that instead of overriding it.
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const msg = activeIdx >= 0 ? messages[activeIdx] : undefined;
      if (!msg) return;
      e.preventDefault();
      void navigator.clipboard
        ?.writeText(messageContent(msg))
        .then(() => announce(m.chat_copied()));
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min((i < 0 ? -1 : i) + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max((i < 0 ? messages.length : i) - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIdx(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIdx(last);
        break;
    }
  };

  const submit = async () => {
    const res = await onSend(text);
    if (res.ok) setText(""); // keep the text on empty / rate_limited
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (it's a multiline editor).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <aside
      className="flex w-full flex-col border-l border-sonic-700 bg-sonic-800 sm:w-80"
      aria-label={m.chat_panel_label()}
      // Escape from anywhere in the panel closes it (Room restores focus to the
      // toggle). Bubbles up from the listbox/composer/buttons.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-sonic-700 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-sonic-100">{m.chat_heading()}</h2>
        <div className="flex items-center gap-1.5">
          {/* How new messages are announced: a polite or assertive ARIA live
              region, the browser's spoken voice (for users without a screen
              reader), or off. Persisted. Choosing "spoken" warms up speech
              synthesis from within this gesture so the first message isn't
              dropped. */}
          <label htmlFor="chat-announce-mode" className="sr-only">
            {m.chat_announce_label()}
          </label>
          <select
            id="chat-announce-mode"
            value={chatAnnounceMode}
            onChange={(e) => {
              const mode = e.target.value as ChatAnnounceMode;
              if (mode === "tts") warmUpTts();
              setChatAnnounceMode(mode);
            }}
            title={m.chat_announce_label()}
            className="rounded-md border border-sonic-600 bg-sonic-900 px-1.5 py-1 text-xs text-sonic-200 focus:border-sonic-accent focus:outline-none"
          >
            <option value="polite">{m.chat_announce_polite()}</option>
            <option value="assertive">{m.chat_announce_assertive()}</option>
            <option value="tts">{m.chat_announce_tts()}</option>
            <option value="off">{m.chat_announce_off()}</option>
          </select>
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            aria-label={m.chat_close()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Message list FIRST (before the composer). A focusable listbox you can
          arrow up/down; each message is an option read as the {sender}: {text}
          sent {when} format. */}
      {messages.length === 0 ? (
        <p className="flex-1 px-4 py-6 text-sm text-sonic-400">{m.chat_empty()}</p>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={m.chat_messages_label()}
          aria-activedescendant={activeId}
          onKeyDown={onListKeyDown}
          onFocus={() => setActiveIdx((i) => (i < 0 ? messages.length - 1 : i))}
          className="flex-1 space-y-1 overflow-y-auto px-2 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
        >
          {messages.map((msg, i) => (
            <li
              key={msg.id}
              id={`chat-opt-${msg.id}`}
              role="option"
              aria-selected={i === activeIdx}
              ref={(el) => {
                if (el) optionRefs.current.set(msg.id, el);
                else optionRefs.current.delete(msg.id);
              }}
              className={`rounded-md px-2 py-1.5 text-sm leading-snug ${
                msg.kind ? "text-center" : ""
              } ${i === activeIdx ? "bg-sonic-accent/20 text-sonic-50" : "text-sonic-200"}`}
            >
              {msg.kind ? (
                <span className="text-xs italic text-sonic-400">
                  {msg.kind === "join"
                    ? m.chat_joined({ name: msg.sender })
                    : msg.kind === "leave"
                      ? m.chat_left({ name: msg.sender })
                      : msg.text}
                  {META_SEP}
                  {relativeTime(msg.ts, now)}
                </span>
              ) : (
                <>
                  <span className="font-medium text-sonic-100">{msg.sender}:</span>{" "}
                  <span>{msg.text}</span>
                  <span className="text-xs text-sonic-400">
                    {META_SEP}
                    {m.chat_sent({ time: relativeTime(msg.ts, now) })}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Composer (after the list). Multiline; Enter sends, Shift+Enter newline. */}
      <form
        className="flex items-end gap-2 border-t border-sonic-700 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="chat-input">
          {m.chat_composer_label()}
        </label>
        <textarea
          id="chat-input"
          ref={textareaRef}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKeyDown}
          aria-describedby="chat-input-help"
          placeholder={m.chat_placeholder()}
          className="flex-1 resize-none rounded-lg border border-sonic-600 bg-sonic-900 px-3 py-2 text-sm text-sonic-100 placeholder:text-sonic-500 focus:border-sonic-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={text.trim().length === 0}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sonic-accent text-white transition-all hover:bg-sonic-accent/90 disabled:opacity-40"
          aria-label={m.chat_send()}
          title={m.chat_send_title()}
        >
          <Send className="h-4 w-4" />
        </button>
        <p id="chat-input-help" className="sr-only">
          {m.chat_help()}
        </p>
      </form>
    </aside>
  );
}
