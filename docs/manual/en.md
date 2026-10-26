---
title: SonicRoom — the screen reader manual
subtitle: How to set your screen reader up, how the keyboard works, and every shortcut
lang: en
---

# Read this part first

**SonicRoom is an application, not a web page.**

That one sentence explains almost every problem people hit. SonicRoom happens to
run in a browser, but nothing in it behaves like an article you read. There is no
document to scroll through. There are toolbars, lists and dialogs, and they are
driven the way a desktop program is driven: **Tab moves between the parts, the
arrow keys move inside a part**.

Screen readers do not know this by themselves. Out of the box, NVDA, JAWS,
Narrator and Orca all put a _virtual copy_ of the page in front of you and
intercept your keys, so that `H` jumps to a heading and `B` jumps to a button.
That is exactly right for a news site and exactly wrong here, because in
SonicRoom `M` mutes your microphone, `R` starts a recording and `W` tells you who
has been talking. If your screen reader swallows those keys, none of them will
ever reach the app.

So the first thing to do — before you join anything — is to put your screen
reader into the mode where the application receives your keystrokes. Each screen
reader calls it something different. The next section tells you how.

If you only remember one thing: **when a single letter does nothing, you are in
the wrong mode.**

---

# Setting your screen reader up

## NVDA

NVDA calls the two modes **browse mode** and **focus mode**.

- Browse mode is the reading mode. Single letters are navigation commands and
  never reach the page.
- Focus mode passes every keystroke straight through to the application. This is
  the mode SonicRoom needs.

**Toggle it with `NVDA` + `Space`.** You will hear a short low sound when focus
mode switches on, and a higher one when you go back to browse mode. Some voices
also say "focus mode" and "browse mode" out loud.

NVDA already switches to focus mode by itself whenever you land on an edit box or
a similar control, so you will often be in focus mode without asking. What it
will _not_ do is switch by itself when you are sitting on a plain button — and
that is precisely when you want to press `M` or `R`. Press `NVDA` + `Space` and
stay in focus mode for the whole call.

If you would like NVDA to be more eager about it, open **NVDA menu → Preferences
→ Settings → Browse Mode** (or press `NVDA` + `Ctrl` + `B`) and turn on
_Automatic focus mode for focus changes_ and _Automatic focus mode for caret
movement_.

## JAWS

JAWS calls its reading mode the **Virtual Cursor** (sometimes the "PC virtual
cursor"), and its pass-through mode **Forms Mode**.

**The recommendation for SonicRoom is to turn the Virtual Cursor off entirely:
press `JAWS key` + `Z`** (the JAWS key is `Insert` by default, or `Caps Lock` on
the laptop layout). JAWS will say "Virtual PC cursor off". Every key you press
from then on goes to SonicRoom.

You _can_ rely on Auto Forms Mode instead — JAWS drops into Forms Mode when you
press `Enter` on a control and leaves it with `NumPad Plus`. It works, but it
fights you here for two reasons: SonicRoom's single-letter commands are not
attached to form controls, so Auto Forms Mode will not trigger for them; and
SonicRoom uses `Escape` for real work (closing the chat panel, closing a dialog,
stopping a file that is playing), which Forms Mode may intercept.

Turning the Virtual Cursor off with `JAWS key` + `Z` avoids both problems. Press
it again to get the Virtual Cursor back when you leave the call.

## Narrator (Windows)

Narrator calls its reading mode **Scan Mode**. Turn it **off** with
`Caps Lock` + `Space`. Narrator will say "Scan off". With Scan Mode off, `Tab`
and the arrow keys behave as this manual describes and single letters reach the
app.

## VoiceOver (macOS)

VoiceOver's equivalent trap is **Quick Nav**. With Quick Nav on, the arrow keys
are VoiceOver navigation commands and never reach the page.

**Turn Quick Nav off by pressing the Left and Right arrow keys together.**
VoiceOver says "Quick Nav off".

After that:

- `Tab` and `Shift` + `Tab` move between the parts of the app.
- The arrow keys move inside a toolbar or a list, as described below.
- Single letters (`M`, `A`, `R`, `W`…) reach SonicRoom as long as the keyboard
  focus is not inside a text field.

`VO` in the shortcuts below means `Control` + `Option`. You may need
`VO` + `Shift` + `Down Arrow` to interact with the web content group before
VoiceOver will follow the focus into the app.

## Orca (Linux)

Orca has **browse mode** and **focus mode** in web content, just like NVDA.
Orca switches to focus mode automatically on form controls; to switch by hand,
press `Orca Modifier` + `A` (the Orca modifier is `Insert` on the desktop
keyboard layout and `Caps Lock` on the laptop layout).

## iPhone, iPad and Android

SonicRoom works with VoiceOver and TalkBack, and every button, list and dialog is
labelled. The single-letter shortcuts need a physical keyboard, so on a touch
screen use the buttons instead — everything a shortcut does has a button
somewhere in the toolbar or the participant list.

Two things behave differently on iOS: Safari cannot show the video full screen
(the app says so out loud rather than leaving a dead button), and the audio
engine only starts after you touch the screen once, which SonicRoom handles for
you on your first tap.

## A ten-second test that you are set up correctly

Join a room on your own, make sure the focus is **not** in the chat box, and
press `M`. If you hear the mute sound and "Microphone muted", you are ready.
If your screen reader says something about a heading, a list, or "no next
element", you are still in the reading mode — go back and toggle it.

---

# How the keyboard works everywhere in SonicRoom

Three rules cover the entire app.

**1. `Tab` moves between parts. The arrow keys move inside a part.**

A toolbar of eleven buttons is a _single_ `Tab` stop, not eleven. A list of
twenty participants is a single `Tab` stop. This is deliberate: it means you can
cross the whole app in five or six presses of `Tab` instead of forty, and it is
how desktop applications have always worked. It also means that pressing `Tab`
inside a toolbar does **not** get you to the next button — `Right Arrow` does.

**2. Toolbars: `Left Arrow` and `Right Arrow`.**

SonicRoom has two toolbars, both at the bottom of the call: the audio controls
(always) and the video controls (video calls only). Inside either one:

| Key                | Does                                      |
| ------------------ | ----------------------------------------- |
| `Right Arrow`      | Next button (wraps round to the first)    |
| `Left Arrow`       | Previous button (wraps round to the last) |
| `Home`             | First button                              |
| `End`              | Last button                               |
| `Enter` or `Space` | Press the button you are on               |
| `Tab`              | Leave the toolbar entirely                |

**3. Lists: `Up Arrow` and `Down Arrow`, then `Enter`.**

The participant list, the chat history, the public-room list in the lobby and the
server file browser are all lists in the same style:

| Key                       | Does                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `Down Arrow` / `Up Arrow` | Next / previous item                                              |
| `Home` / `End`            | First / last item                                                 |
| `Enter` or `Space`        | Open or activate the item                                         |
| `Escape` or `Backspace`   | Go back a level (in the participant options and the file browser) |

Your screen reader will announce each item as you arrow onto it, along with its
state — muted, speaking, sharing video, and so on.

**Sliders** (your microphone level, another person's volume) live inside the
participant options list. On a slider, `Left Arrow` and `Right Arrow` change the
value and speak the new percentage; `Home` and `End` jump to the minimum and the
maximum. `Up Arrow` and `Down Arrow` keep their usual job of moving to the next
option.

**`Escape` closes things.** The chat panel, the audio settings, the streaming
settings, the audio source picker, the API key box, the file player and video
full screen all close with `Escape`, and focus goes back to the control you
opened them from. The one exception is the "someone wants to join" dialog, which
you must answer.

---

# The lobby

The lobby is the first screen. It is an ordinary form, so it is fine to read it
in browse mode if you prefer — but the public-room list needs arrow keys, so
focus mode is still easier.

In order, top to bottom:

1. **Language** — a combo box. Changing it re-labels everything immediately, in
   the lobby and in a call, without a reload.
2. **Room Name** — letters, numbers, hyphens and underscores, up to 64
   characters. Anything else is stripped out as you type. If nobody is in a room
   by that name yet, typing it creates it.
3. **Room type** — two radio buttons, **Audio call** and **Video call**. Audio is
   always the default. Pick with the arrow keys. This decision is permanent for
   the life of the room, and it decides whether cameras exist at all.
4. **Video background** — only appears if you chose _Video call_. See
   [Video calls](#video-calls).
5. **Display Name** — the name everyone will hear when you join, speak or send a
   message.
6. **Public rooms** — a list of rooms that are currently open to anyone,
   with who is in each. Only shown when at least one exists. Arrow to a room and
   press `Enter` to fill its name in for you; focus jumps back to Display Name so
   you can just type your name.
7. **Mic level** — a **Test** button, a **Microphone level** slider and a live
   level meter. Press Test and you will hear yourself (use headphones), and your
   screen reader will tell you when the level moves between _silent_, _low_,
   _good_ and _high_. Raise the slider until it says good. That level carries
   into the call. This is worth doing once — a lot of laptop microphones are far
   too quiet by default.
8. **Disable P2P** — a checkbox. With two people, SonicRoom normally connects you
   directly to each other. Tick this to always relay through the server instead.
   Most people never need it.
9. **Make this room public** — a checkbox. Lists the room publicly, and turns on
   the knock-to-join and vote-to-kick rules described further down. Once anyone
   makes a room public it stays public until everybody leaves; unticking it later
   does not undo it.
10. **Join without a microphone** — a checkbox. You listen and use text chat, and
    the browser never asks for microphone permission. If you have no microphone,
    or you refuse the permission prompt, you end up in this mode anyway.
11. **Join Room** — the submit button. `Enter` from any of the text fields works
    too.

**The form is shorter when the room already exists.** A room's type, its P2P
and public settings and its admin options belong to whoever creates it. So as
soon as the name in the field is a room that is open right now — whether you
typed it, picked it from the public list or arrived through a link — the lobby
keeps only what is yours to change: your display name, the microphone test,
_Join without a microphone_, the video background if it is a video room, and the
Join button. Your screen reader says so when it happens ("A room named … is
already open, so you'll be joining it. Hiding the room options."), and the same
explanation sits under the room name field, read again whenever you land on it.
Change the name to one nobody is using and the options come back, again with an
announcement. The lobby checks a moment after you stop typing, and keeps
checking while you stay on the page, so the form can also change by itself if a
room opens or empties in the meantime. A [reserved room](#reserved-rooms-a-room-you-were-given-in-advance) that
its host has not opened yet behaves the same way: nothing there is yours to
choose, you will simply wait for the host.

---

# The room, part by part

## Header

Reads the room name and the name of this SonicRoom instance, then any badges that
apply — **VIDEO** for a video call, **REC** while the call is being recorded,
**LIVE** while it is being streamed out — then the number of people present, then
the **chat** button (which also carries the unread count in its name), then the
language combo box.

## Participant list

The heart of the app. It is one list containing **you first, then everybody
else**, and then one row for every extra thing being sent into the room: a music
caster, a shared screen's audio, a file somebody is streaming, an extra
microphone.

Each row is read as the person's name followed by whatever is true right now,
for example:

> Ana (you), muted, sharing video, press Enter to open options for this
> participant

The pieces you may hear are: _you_, _text only_ (joined without a microphone),
_muted_, _speaking_, _sharing video_, _sharing screen_, _pinned_, _muted by you_,
and a vote count when a vote to remove that person is running.

Press `Enter` on a row to open that person's options. This replaces the list with
a second list, and `Escape` or `Backspace` brings you back.

## Participant options

What you find here depends on whose row you opened.

**On your own row:**

- **Your microphone level** — a slider. `Left`/`Right` to change, `Home`/`End`
  for minimum and maximum. This is a boost applied before your voice leaves your
  machine, so it changes what everyone hears.
- **Describe my video** and **Pin my video** — video calls only.

**On somebody else's row:**

- **Volume for _name_** — a slider. Only changes what _you_ hear.
- **Mute _name_ for me** / **Unmute _name_ for me** — silences them for you
  alone. They are not told. The label flips to say what pressing it will do next.
- **Pin _name_'s video** / **Pin _name_'s screen** — video calls only, and purely
  a change to your own screen; the person you pin is never told.
- **Describe _name_'s video** / **Describe _name_'s screen** — video calls only.
  See [Video calls](#video-calls).
- **Kick _name_** — only in public rooms with three or more people. See
  [Public rooms, knocking and voting](#public-rooms-knocking-and-voting).
- **Remove caster** — removes a music-casting source.
- **Stop this stream** — stops one shared file, shared screen audio or extra
  microphone.

## Chat panel

Open it with the chat button in the header. The panel is laid out **message
history first, message box second**, on purpose, so that you land on what was
said rather than on an empty edit field.

- The message list is a list: `Up`/`Down`, `Home`/`End`.
- `Ctrl` + `C` (or `Cmd` + `C`) on a message copies it.
- In the message box, `Enter` sends and `Shift` + `Enter` starts a new line.
- **Announce new messages** is a combo box in the panel's header with four
  settings: _Polite_ (spoken when your screen reader next pauses), _Assertive_
  (interrupts), _Spoken aloud_ (the browser's own voice, for people not using a
  screen reader) and _Off_.
- `Escape` closes the panel and puts focus back on the chat button.

You do not have to keep the panel open. Everything that happens in the room is
written into the chat history as well as spoken, and `Alt` + a number reads it
back from anywhere — see [Hearing what is going on](#hearing-what-is-going-on).

## The audio controls toolbar

At the bottom of the window. One `Tab` stop; `Left`/`Right` to move along it. In
order:

| Button          | Shortcut    | What it does                                                                                                          |
| --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Mute microphone | `M`         | Mutes and unmutes you. Disabled, but still readable, if you joined without a microphone.                              |
| Share audio     | `A`         | Shares the sound of a screen or browser tab. Your browser asks which one, and you must tick its "share audio" box.    |
| Stream audio    | `F`         | Opens the source picker: a file from your computer, a link, or a file stored on the server.                           |
| Auto-ducking    | `D`         | Turns the automatic dip of music under voices on or off, **for the whole room**.                                      |
| Record call     | `R`         | Starts and stops a server-side recording of everybody.                                                                |
| Download        | —           | Appears once a recording exists. Downloads the whole call mixed together.                                             |
| Tracks          | —           | Appears once a recording exists. Downloads a zip with one file per person, all aligned and padded to the same length. |
| Live streaming  | —           | Opens the panel where you type an Icecast server's details and start streaming the call out to it.                    |
| Who's talking   | `W`         | Says who is talking now or talked recently, numbered.                                                                 |
| Shared notes    | `Alt` + `N` | Opens this room's shared notepad in a new tab. Only present if this instance has the feature configured.              |
| Audio settings  | —           | Microphone and speaker pickers, voice processing, hi-fi voice, extra microphones.                                     |
| Leave           | —           | Leaves the call and returns to the lobby.                                                                             |

## Footer

A link back to the SonicRoom project, and the link to this manual.

---

# Every keyboard shortcut

These work anywhere in the call, **as long as the keyboard focus is not inside a
text box** and your screen reader is passing keys through. They stop working
while a "someone wants to join" dialog is open, because that dialog has to be
answered first.

## Single letters

| Key | Action                                              |
| --- | --------------------------------------------------- |
| `M` | Mute / unmute your microphone                       |
| `A` | Start / stop sharing screen or tab audio            |
| `F` | Open the "Stream audio" picker                      |
| `D` | Auto-ducking on / off for the whole room            |
| `R` | Start / stop recording                              |
| `W` | Who's talking — announces recent speakers, numbered |
| `V` | Camera on / off — **video calls only**              |
| `E` | Video full screen on / off — **video calls only**   |

`V` and `E` do nothing in an audio call, so those letters stay free there.

## With Alt

On a Mac, `Alt` means the **Option** key (the one next to Command) — everything
below works the same with it, and the app labels these shortcuts "Option" there.

| Key                                    | Action                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `Alt` + `1` … `Alt` + `9`              | Read the last messages aloud. `1` is the newest, `2` the one before it, and so on. |
| `Alt` + `0`                            | Read the tenth most recent message.                                                |
| The same `Alt` + number twice, quickly | Copy that message to the clipboard.                                                |
| `Alt` + `N`                            | Open this room's shared notes in a new tab.                                        |
| `Ctrl` + `Shift` + `M`                 | Mute everyone's microphones — **moderated rooms only**, and only if you may.       |

The `Alt` + number readback is the one set of shortcuts that **also works while
you are typing in the chat box**, and it works whether the chat panel is open or
closed. It reads the physical number keys, so it is unaffected by AZERTY,
Dvorak or any other layout.

## Navigation and closing

| Key                     | Action                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| `Tab` / `Shift` + `Tab` | Move between the parts of the app                                           |
| `Left` / `Right`        | Move along a toolbar, or change a slider                                    |
| `Up` / `Down`           | Move through a list                                                         |
| `Home` / `End`          | First / last item, or minimum / maximum of a slider                         |
| `Enter` / `Space`       | Activate what you are on                                                    |
| `Escape`                | Close the panel, dialog or full screen you are in                           |
| `Backspace`             | Back out of the participant options; up a folder in the server file browser |
| `Enter`                 | Send a chat message                                                         |
| `Shift` + `Enter`       | New line in a chat message                                                  |
| `Ctrl` / `Cmd` + `C`    | Copy the chat message you are on                                            |

---

# Hearing what is going on

SonicRoom is built around one rule: **anything the room is told, you can read
again later.**

Every room event — somebody joined, a recording started, a file
started playing, somebody was removed — is spoken through a live region _and_
written into the chat history as a system message. Nothing is announced once and
lost. If your screen reader was busy, or you were typing, or you simply missed
it, press `Alt` + `1` and walk back through it.

Three things are spoken but deliberately _not_ written to chat, because they are
about your own view rather than about the room: your own local volume changes,
muting somebody for yourself, and pinning a video. Nobody else is affected by
those, so they do not belong in a shared timeline.

**Other people muting and unmuting is a sound, not a sentence.** In a busy room
the mute key gets ridden constantly, and "so-and-so muted their microphone" over
and over buries everything worth hearing. So when somebody else mutes or unmutes
themselves you get the short mute or unmute cue and nothing spoken; their row in
the participant list still reads "muted", and `W` still tells you who is talking.
An administrator muting somebody _for everyone_ is different — that is a room
event, and it is both spoken and written to the chat, naming who did it.

**Sound cues.** Short sounds play for mute, unmute, someone joining, someone
leaving, a new chat message, a share starting or stopping, someone knocking to
get in, and a camera going on or off. They are local — the room never hears
them — and they are designed to be distinguishable from speech.

**"Who's talking" (`W`).** Voices come and go and a screen reader cannot follow
them. Press `W` and SonicRoom names the people who are talking now or talked in
the last little while, numbered "1. Ana, 2. Luis, 3. Marta" — most recent first.
The same numbers appear briefly on their tiles, so a sighted person next to you
sees the same list.

---

# Talking and listening

**Mute** with `M`, or the first button in the toolbar. Muting affects your voice
only. If you are also streaming a file, sharing screen audio or running extra
microphones, those keep going — you stop them by stopping them, not by muting.

**Your own level** is the slider in your own row of the participant list, and
also the slider in the lobby. Raise it if people say you are quiet.

**Somebody else's level** is the slider in _their_ row of the participant list.
That one changes only what you hear.

**Auto-ducking (`D`)** makes music dip automatically whenever someone talks, and
lift again when they stop. It is on by default and it is a room-wide setting, so
turning it off turns it off for everybody. Announced either way.

**Audio settings** (the gear in the toolbar) holds:

- **Microphone** and **Speakers** — device combo boxes. Changing them applies
  immediately, mid-call, and is remembered. Device names only appear once you
  have granted microphone permission.
- **Voice processing** — echo cancellation, noise suppression and automatic
  levelling. On by default. Turn it off if you are sending music or playing an
  instrument, since it will fight you.
- **Hi-fi voice (stereo)** — sends stereo at a higher bitrate. Off by default,
  because most microphones are mono and it costs everyone else bandwidth. It
  applies to your **next** call, not the one you are in.
- **Extra microphones to stream** — a list of checkboxes, one per input device
  you own other than your main microphone, each with a **Mono** / **Stereo**
  radio pair. Tick one and it is sent into the room as its own separate stream,
  alongside your voice, appearing as its own row in everyone's participant list.
  This is how people send a mixing desk, an instrument or a virtual audio cable.
  Muting yourself does not mute these; untick them to stop them.

---

# Sharing audio into the room

## Screen or tab audio (`A`)

Press `A` and your browser opens its own picker — a system dialog, not part of
SonicRoom, so your screen reader treats it as a separate window. Choose a screen,
window or tab, **and tick the checkbox that shares its audio**; without that box
the share is silent. Chrome and Edge do this best; Firefox's support for sharing
system audio is limited or absent depending on your platform.

Shared audio bypasses your microphone's processing and limiter, so music keeps
its dynamics. In an audio call the picture is thrown away and only the sound is
sent. `A` again stops it.

## A file, a link or a server file (`F`)

`F` opens the **Stream audio** dialog, which offers three sources:

- **Choose from computer** — a file picker.
- **Audio URL** — an edit box. Paste any public link: a direct MP3, an internet
  radio stream, or a page on a video or music site, which the server extracts the
  audio from for you.
- **Server files** — a browsable folder tree of audio kept on the server.
  Arrow through it, `Enter` on a folder to go in, `Enter` on a file to play it,
  `Backspace` to go back up a folder. Long names are truncated visually but read
  in full.

Once something is playing, a small **File stream** window appears and focus lands
on its play/pause button, so `Space` pauses immediately. It also has a **Your
volume** slider, which changes only your own monitoring — the room always hears
the file at full level — and a stop button. `Escape` anywhere in that window
stops the stream and closes it.

Pressing `F` again while something is playing opens the picker again and lets you
swap to a different source without restarting the stream.

---

# Recording and live streaming

**Recording (`R`)** happens on the server, so it captures everyone at full
quality regardless of what your own machine is doing. Starting and stopping is
announced to the whole room and a **REC** badge appears in the header — nobody is
recorded without being told.

Once a recording exists, two more buttons appear in the toolbar:

- **Download** — the whole call mixed into one file. You can press it while the
  recording is still running; it downloads everything so far and the recording
  carries on.
- **Tracks** — a zip with one file per person, each padded and time-aligned so
  they line up when dropped into an audio editor.

In a video call, the whole-call download is a video file with everybody's cameras
and screens in a grid; in an audio call it is an audio file, as it always was.

**Live streaming** (the radio button in the toolbar) sends the whole mixed call
to an Icecast server you specify. The panel asks for host, port, mount, user,
password, format and bitrate, and remembers them in this browser. Those details
are never shown to the rest of the room; all they get is a **LIVE** badge and an
announcement that streaming started, and by whom.

---

# Video calls

A room is a video call only if it was created as one — the **Video call** radio in
the lobby, which cannot be changed back afterwards. In an audio call, none of
this exists: no camera, no `V`, no `E`, and sharing your screen still sends only
its sound.

**Everybody enters with their camera off**, every time. Nothing turns your camera
on except you.

- **`V`** turns your camera on and off. Everyone is told, in speech and in the
  chat log.
- **`E`** makes the video area fill the screen; `E` again or `Escape` leaves it.
  Announced both ways. On iOS Safari, which has no full screen for page elements,
  SonicRoom says so rather than doing nothing.
- **Pinning** makes one camera or screen fill the video area for you alone.
  It is in each participant's options ("Pin _name_'s video"), it is never
  signalled to anyone, and the person you pin is not told. If they turn their
  camera off, the pin is kept and waits — you are told it is waiting, and told
  again when the picture comes back.

**Face-centering guidance** is the button next to the camera button, on by
default. While your camera is on, SonicRoom watches your own picture and speaks
short corrections — "move to your right", "move up", "you're centered", "your
face isn't visible in the frame" — on an assertive live region, so they interrupt
rather than queue. The directions are given from your point of view, not the
picture's. It repeats the same hint every three seconds while it still applies,
says "centered" once when you get there, and goes quiet. Turn it off with the
same button when you have finished adjusting.

**"Describe _name_'s video"** is in each participant's options, including your
own. It takes a single frame and asks Claude to describe it in a few sentences,
reading out any text that is visible, in whatever language the interface is set
to. The description is logged to chat like everything else, so `Alt` + `1` reads
it again.

This needs **your own Claude API key**, which you enter with the key button in
the video toolbar. It is stored in this browser only and the request goes from
your browser straight to Claude — it never passes through the SonicRoom server.

**Video backgrounds** are chosen in the **lobby**, under the _Video call_ radio,
and never in the call — that way the picture is settled before anything is sent.
The choices are no background, blur, one of six supplied images, or your own
image. Everything is done inside your browser, so the room only ever receives the
finished picture and never your real surroundings. If your browser cannot do it,
SonicRoom says so out loud and sends your camera unchanged rather than quietly
failing.

---

# Public rooms, knocking and voting

**There are no moderators in an ordinary SonicRoom room, and no owner.** Nobody
can remove anybody on their own. In exchange, public rooms have two collective
rules. (**Moderated rooms**, which do have administrators, are a separate thing:
see the next chapter.)

**Knock to join.** When a room is public and somebody new asks to come in,
everybody already inside hears a knocking sound and gets a dialog naming the
person, with **Allow** and **Deny** buttons (and **Allow all** / **Deny all**
when several are waiting). Focus goes straight to the first Allow button, and
`Tab` cycles inside the dialog. It cannot be dismissed with `Escape` — this is
the one dialog you have to answer. Anyone may answer it; the first answer counts.
Denying somebody also blocks them from that room.

Meanwhile the person knocking hears "Waiting for someone in the room to let you
in…" and has a Cancel button.

**Vote to kick.** Only in public rooms, and only with **three or more people**
present. Below three the option is not offered at all, so it can never be used by
one person against another. The threshold is _at least half_, counting the person
concerned: 2 votes out of 3, 2 out of 4, 3 out of 5.

The option is in each participant's options list. Its name carries the running
tally — "Kick Ana (2 votes)" — and every vote and withdrawal is announced to the
whole room, with names. Choosing it again withdraws your vote. Because the
threshold depends on how many people are present, somebody leaving can be what
tips an existing vote over the line.

---

# Moderated rooms (with administrators)

Besides private and public rooms, which have no moderators, you can create a
**moderated room**: a room with **administrators**, meant for talk shows and
hosted panels, where somebody has to be able to silence the person who forgot
to mute or eject a troll at once. Everything below exists only in this kind of
room; an ordinary room is unchanged.

**Creating one.** In the lobby, tick **"Admin options"**. A group called
**"Participant privileges"** unfolds, with a checkbox ("Allow several
administrators") and one drop-down list per action: recording, sharing audio,
streaming audio, turning auto-ducking on or off, live streaming, approving new
participants, using the chat, opening the shared notes, muting a participant
for everyone, muting everyone's microphones, and removing participants. For each you pick
**Administrators only**, **Everyone** or **Nobody** (removing also offers **by
vote**). The last checkbox hides the "Powered by SonicRoom" link inside the
room. These choices are fixed when the room is created and never change while
it exists; the browser remembers your last configuration for next time.

**Who is an administrator.** Whoever creates the room. If you allowed several
administrators, every participant's options include **"Make administrator"**
(and **"Remove administrator"** to undo it). Administrators carry the word
"administrator" in their row of the list. If you reload or lose the connection,
you get the role back when you return.

**If every administrator leaves** while people remain, the room **stops being
moderated**: it is announced to everyone ("The last administrator has left: this
room is no longer moderated"), every button comes back for everybody, the chat
reopens, and the room carries on as an ordinary private or public room for the
rest of its life. Nobody is promoted in the leavers' place, and a former
administrator who comes back is a regular participant. If you want the room to
survive your absence with its rules intact, name a second administrator before
you go.

**The door.** In a moderated room newcomers **always** knock, public or not.
The "Approve new participants" setting decides who hears the knock and gets the
Allow / Deny dialog: administrators only, or everyone. Administrators walk in
without knocking.

**Muting somebody for everyone.** In the participant's options: **"Mute for
everyone"**. Their microphone is cut for the whole room and they are told who
did it. It is a _soft_ mute: the person can turn their microphone back on with
`M` when they mean to speak (which settles the classic "we can hear you talking
to your neighbour" without a raise-hand flow). In the controls bar, whoever is
allowed also sees **"Mute everyone's microphones"**, which does the same to
everybody else at once. Its shortcut is `Ctrl` + `Shift` + `M` — a deliberate
three-key chord, so it cannot be hit by mistake next to `M`. It only exists in a
moderated room; elsewhere the browser keeps that combination.

**Removing people.** Depending on the setting: administrators (or everyone)
remove directly from the participant's options with **"Remove from room"**, no
vote; or the room votes as a public room does (with **at least three** eligible
voters; if only administrators vote, only they count). Nobody can remove
themselves. An administrator can only be muted or removed by another
administrator.

**What you may not do is not shown.** If your role doesn't allow recording,
sharing or streaming audio, changing ducking, live streaming or writing in the
chat, that button is not in the bar and the matching letter (`R`, `A`, `F`,
`D`) answers "You can't do that in this room". The chat panel still opens even
if you can't write, because every announcement still lands there. The same goes
for a recording's **Download** and **Tracks** buttons: they appear only for the
people allowed to record — everybody else still hears that the call is being
recorded and sees the **REC** badge, but is never handed the file. Someone named
administrator while an administrators-only recording exists is told they can now
download it.

The room carries the **MOD** badge in the header, and on entry it is announced
as moderated along with who the administrators are. Every change (naming,
mutes, removals) is announced and logged to the chat.

## Reserved rooms (a room you were given in advance)

A room normally exists only while somebody is in it, and whoever arrives first
creates it. That is a problem when you advertise a link ahead of time: anyone
could open "your" room before you and become its administrator, or the
moderated room could simply vanish the moment it empties. A **reserved room**
fixes this. The operator of the instance reserves a room name for you and gives
you **two links**:

- the **host link**, which contains a secret key. Keep it to yourself; whoever
  opens the room with it is its **administrator**, every time, even after
  leaving and coming back;
- the **public link**, the ordinary room address, which you advertise.

Until you open the room with the host link, everyone else who follows the
public link hears "This room is reserved and its host hasn't opened it yet" and
waits on that screen; they are let in automatically as soon as you arrive (and
then knock like anybody joining a moderated room, so you decide who enters). A
reserved room is always a moderated room, with the participant privileges the
operator set when reserving it, and it **stays moderated** while you are away:
nobody can take it over, and you come back as its administrator.

The key is remembered by your browser for that tab, so you can reload the page
or be sent to the lobby for your name without losing it, and it is removed from
the address bar at once so that a copied link never carries it. If you lose the
host link, ask the operator for a new one (the old one stops working).

---

# Shared notes

If this SonicRoom instance has notes configured, the toolbar has a **Shared
notes** button and `Alt` + `N` does the same thing. It opens one shared,
collaborative notepad for the room **in a new browser tab** — never in a frame
inside the call, so your screen reader deals with an ordinary editable document.

The first press creates the note; everyone else's press opens the same one, and
the fact that it exists is announced and logged to chat with the link. Switch
back to the SonicRoom tab and the call is still running.

---

# Options you can put in the address bar

Anything after `?` in a room link sets an option, and several can be combined
with `&`.

| Option             | Effect                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `?displayName=Ana` | Joins with this name, skipping the lobby                                                       |
| `?video=on`        | Makes it a video call                                                                          |
| `?public=true`     | Makes the room public                                                                          |
| `?mic=off`         | Joins without a microphone — listening and chat only                                           |
| `?p2p=off`         | Always relays through the server, even with two people                                         |
| `?lang=es`         | Forces the interface language (`en`, `es`, `fr`)                                               |
| `?ios=on`          | Forces the iOS audio path on any browser (a workaround for stubborn audio problems)            |
| `?host=…`          | Opens a reserved room as its host (see "Reserved rooms"); removed from the address bar at once |

For example, a link that drops somebody straight into a French-language video
call as "Ana":

```
https://your-instance.example/room/studio?video=on&lang=fr&displayName=Ana
```

---

# When something is not working

**A single letter types nothing and does nothing.**
Your screen reader is in its reading mode and eating the key. `NVDA` + `Space`,
`JAWS key` + `Z`, `Caps Lock` + `Space` for Narrator, or turn Quick Nav off for
VoiceOver. This is by far the most common problem.

**A single letter appears in the chat box instead.**
The focus is in the message box. That is deliberate — you have to be able to type
the letter M in a message. Press `Escape` to close the chat panel, or `Tab` out of
the box, then try again. `Alt` + number is the one shortcut that still works from
inside the box.

**`Tab` will not move me to the next button in the toolbar.**
It is not meant to. The whole toolbar is one stop; use `Right Arrow`. `Tab`
leaves the toolbar.

**`Alt` + a number says "No message 1".**
Nothing has been said in the room yet. Room events count as messages, so the
first join will fill it.

**I cannot hear anyone.**
Check the **Speakers** combo box in the audio settings — browsers do not always
follow the system default. Then check that you have not muted that person for
yourself: their row would read "muted by you".

**People say I am very quiet.**
Raise **Your microphone level** in your own row of the participant list, or use
the lobby's Test button, which speaks the level band as you adjust it.

**My extra microphone did not start.**
SonicRoom asks for that exact device rather than accepting a substitute, so if it
is in use by another program or unplugged, it fails instead of silently sending
your main microphone twice. Close whatever is holding the device and tick it
again.

**Sharing a screen shares no sound.**
The audio checkbox in the browser's own share dialog was not ticked. That dialog
belongs to the browser, not to SonicRoom. Try Chrome or Edge if your browser does
not offer the option at all.

**"Describe video" says to add an API key.**
That feature uses your own Claude API key, entered with the key button in the
video toolbar. It is kept in this browser only.

---

# One-page key reference

| Key                                  | Action                                   |
| ------------------------------------ | ---------------------------------------- |
| `M`                                  | Mute / unmute                            |
| `A`                                  | Share / stop sharing screen or tab audio |
| `F`                                  | Stream audio — open the source picker    |
| `D`                                  | Auto-ducking on / off (whole room)       |
| `R`                                  | Start / stop recording                   |
| `W`                                  | Who's talking                            |
| `V`                                  | Camera on / off (video calls)            |
| `E`                                  | Video full screen (video calls)          |
| `Alt` + `1`…`9`, `0`                 | Read the last ten messages, newest first |
| Same `Alt` + number twice            | Copy that message                        |
| `Alt` + `N`                          | Shared notes in a new tab                |
| `Ctrl` + `Shift` + `M`               | Mute everyone (moderated rooms)          |
| `Tab` / `Shift` + `Tab`              | Between parts of the app                 |
| `Left` / `Right`                     | Along a toolbar; change a slider         |
| `Up` / `Down`                        | Through a list                           |
| `Home` / `End`                       | First / last; minimum / maximum          |
| `Enter` / `Space`                    | Activate                                 |
| `Escape`                             | Close panel, dialog or full screen       |
| `Backspace`                          | Back out of options; up a folder         |
| `Enter` in the message box           | Send                                     |
| `Shift` + `Enter` in the message box | New line                                 |
| `Ctrl` / `Cmd` + `C` on a message    | Copy it                                  |
| `NVDA` + `Space`                     | NVDA: browse mode ↔ focus mode           |
| `JAWS key` + `Z`                     | JAWS: Virtual Cursor off / on            |
| `Caps Lock` + `Space`                | Narrator: Scan Mode off / on             |
| `Left` + `Right` together            | VoiceOver: Quick Nav off / on            |
| `Orca Modifier` + `A`                | Orca: browse mode ↔ focus mode           |
