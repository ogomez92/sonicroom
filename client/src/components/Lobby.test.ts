// The lobby reshapes itself around the room name: creating a room shows every
// room option, joining a live one shows only what is the joiner's to change.
// (.ts + createElement: the vitest include only picks up *.test.ts.)
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Lobby, roomLookupTiming } from "./Lobby";
import { loadRoomPolicy } from "../lib/moderation";
import { m } from "../paraglide/messages.js";

type RoomAnswer = { exists: boolean; reserved?: boolean; isVideo?: boolean };

const realFetch = globalThis.fetch;
const realTiming = { ...roomLookupTiming };
// name → what /api/rooms/:name says (absent = 404, nobody there). Mutable so a
// test can open or empty a room under the visitor.
let rooms: Record<string, RoomAnswer>;
let lookups: string[];

function Landed() {
  const loc = useLocation();
  return createElement("div", { "data-testid": "landed" }, loc.pathname + loc.search);
}

function renderLobby(url = "/") {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [url] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/", element: createElement(Lobby) }),
        createElement(Route, { path: "/room/:roomName", element: createElement(Landed) }),
      ),
    ),
  );
}

const roomField = () => screen.getByLabelText(m.lobby_room_name_label());
const nameField = () => screen.getByLabelText(m.lobby_display_name_label());
const typeRoom = (value: string) => fireEvent.change(roomField(), { target: { value } });
// The lobby's own live region (MicPreview has a status region of its own).
const status = () => document.getElementById("lobby-announcer")?.textContent;
const roomOptions = () => ({
  type: screen.queryByRole("group", { name: m.lobby_room_type_legend() }),
  p2p: screen.queryByLabelText(m.lobby_disable_p2p()),
  pub: screen.queryByLabelText(m.lobby_make_public()),
  admin: screen.queryByLabelText(m.lobby_admin_options()),
});

beforeEach(() => {
  rooms = {};
  lookups = [];
  sessionStorage.clear();
  roomLookupTiming.debounceMs = 5;
  roomLookupTiming.pollMs = 20;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/public-rooms"))
      return { ok: true, status: 200, json: async () => ({ rooms: [] }) };
    const name = decodeURIComponent(url.split("/api/rooms/")[1] ?? "");
    lookups.push(name);
    const answer = rooms[name];
    return answer?.exists
      ? { ok: true, status: 200, json: async () => ({ name, ...answer }) }
      : { ok: false, status: 404, json: async () => ({ name, ...answer, exists: false }) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  Object.assign(roomLookupTiming, realTiming);
});

describe("Lobby — creating vs joining", () => {
  it("shows every room option for a name nobody is using, without announcing", async () => {
    renderLobby();
    typeRoom("fresh");
    await waitFor(() => expect(lookups).toContain("fresh"));
    const o = roomOptions();
    expect(o.type && o.p2p && o.pub && o.admin).toBeTruthy();
    expect(status()).toBe("");
    expect(screen.queryByText(m.lobby_room_exists_note())).toBeNull();
  });

  it("hides the room options and says so when the typed room already exists", async () => {
    rooms.studio = { exists: true };
    renderLobby();
    typeRoom("Studio");
    await waitFor(() => expect(roomOptions().admin).toBeNull());
    const o = roomOptions();
    expect(o.type || o.p2p || o.pub).toBeNull();
    // What stays is the joiner's own: name, mic options, the join button.
    expect(nameField()).toBeTruthy();
    expect(screen.getByLabelText(m.lobby_join_without_mic())).toBeTruthy();
    expect(status()).toBe(
      `${m.lobby_room_exists_announce({ name: "studio" })} ${m.lobby_room_options_hidden()}`,
    );
    // …and the reason is on screen, as the room field's description.
    expect(roomField().getAttribute("aria-describedby")).toContain("room-status-note");
    expect(screen.getByText(m.lobby_room_exists_note()).id).toBe("room-status-note");
  });

  it("brings them back (and says so) when the name changes to a free one", async () => {
    rooms.studio = { exists: true };
    renderLobby();
    typeRoom("studio");
    await waitFor(() => expect(roomOptions().admin).toBeNull());
    typeRoom("studio2");
    await waitFor(() => expect(roomOptions().admin).not.toBeNull());
    expect(status()).toBe(
      `${m.lobby_room_new_announce({ name: "studio2" })} ${m.lobby_room_options_shown()}`,
    );
    expect(screen.queryByText(m.lobby_room_exists_note())).toBeNull();
  });

  it("notices a room opening under the visitor, and rescues focus from a hidden control", async () => {
    renderLobby();
    typeRoom("studio");
    await waitFor(() => expect(lookups).toContain("studio"));
    const p2p = roomOptions().p2p as HTMLInputElement;
    p2p.focus();
    rooms.studio = { exists: true };
    await waitFor(() => expect(roomOptions().p2p).toBeNull());
    expect(document.activeElement).toBe(nameField());
  });

  it("holds the options back for a linked room until the server answers", async () => {
    rooms.studio = { exists: true };
    renderLobby("/?room=studio");
    // First paint: no options to yank away later.
    expect(roomOptions().admin).toBeNull();
    await waitFor(() => expect(screen.queryByText(m.lobby_room_exists_note())).not.toBeNull());
    expect(roomOptions().admin).toBeNull();
    // Nothing was hidden, so it only says where the link leads.
    expect(status()).toBe(m.lobby_room_exists_announce({ name: "studio" }));
  });

  it("shows the options for a linked room that turns out to be empty", async () => {
    renderLobby("/?room=empty");
    await waitFor(() => expect(roomOptions().admin).not.toBeNull());
    expect(status()).toBe(
      `${m.lobby_room_new_announce({ name: "empty" })} ${m.lobby_room_options_shown()}`,
    );
  });

  it("offers the video background when joining a live VIDEO room, not an audio one", async () => {
    rooms.cine = { exists: true, isVideo: true };
    rooms.radio = { exists: true };
    renderLobby();
    // jsdom has no canvas.captureStream, so the picker renders its
    // "unsupported" line — either way, it is mounted or it isn't.
    const picker = () => screen.queryByText(m.lobby_background_unsupported());
    typeRoom("cine");
    await waitFor(() => expect(picker()).not.toBeNull());
    typeRoom("radio");
    await waitFor(() => expect(picker()).toBeNull());
  });
});

describe("Lobby — what a join sends", () => {
  const submit = () => fireEvent.click(screen.getByRole("button", { name: m.lobby_join_room() }));
  const landed = () => screen.getByTestId("landed").textContent;

  it("carries the room options when creating", async () => {
    renderLobby();
    typeRoom("fresh");
    fireEvent.change(nameField(), { target: { value: "Ana" } });
    await waitFor(() => expect(lookups).toContain("fresh"));
    fireEvent.click(screen.getByLabelText(m.lobby_make_public()));
    fireEvent.click(screen.getByLabelText(m.lobby_room_type_video()));
    fireEvent.click(screen.getByLabelText(m.lobby_admin_options()));
    submit();
    expect(landed()).toBe("/room/fresh?public=true&video=on");
    expect(loadRoomPolicy("fresh")).not.toBeNull();
  });

  it("drops ticks that are no longer on screen when the room turns out to exist", async () => {
    rooms.studio = { exists: true };
    renderLobby();
    fireEvent.change(nameField(), { target: { value: "Ana" } });
    // Ticked while the form was still the "create" one…
    fireEvent.click(screen.getByLabelText(m.lobby_make_public()));
    fireEvent.click(screen.getByLabelText(m.lobby_disable_p2p()));
    fireEvent.click(screen.getByLabelText(m.lobby_room_type_video()));
    fireEvent.click(screen.getByLabelText(m.lobby_admin_options()));
    fireEvent.click(screen.getByLabelText(m.lobby_join_without_mic()));
    // …then the name of a live room goes in. All of those are sticky for any
    // joiner server-side, so none may ride along; the joiner's own choice does.
    typeRoom("studio");
    await waitFor(() => expect(roomOptions().admin).toBeNull());
    submit();
    expect(landed()).toBe("/room/studio?mic=off");
    expect(loadRoomPolicy("studio")).toBeNull();
  });
});

describe("Lobby — reserved rooms", () => {
  it("hides everything from an early visitor, who will just wait for the host", async () => {
    rooms.gala = { exists: false, reserved: true };
    renderLobby();
    typeRoom("gala");
    await waitFor(() => expect(roomOptions().admin).toBeNull());
    expect(roomOptions().type).toBeNull();
    expect(screen.getByText(m.lobby_room_reserved_note())).toBeTruthy();
    expect(status()).toBe(
      `${m.lobby_room_reserved_announce({ name: "gala" })} ${m.lobby_room_options_hidden()}`,
    );
  });

  it("lets the host pick the room options, minus the admin policy the reservation owns", async () => {
    rooms.gala = { exists: false, reserved: true };
    sessionStorage.setItem("sonicroom:hostKey:gala", "key");
    renderLobby("/?room=gala");
    await waitFor(() => expect(roomOptions().type).not.toBeNull());
    expect(roomOptions().pub).not.toBeNull();
    expect(roomOptions().admin).toBeNull();
    expect(screen.getByText(m.lobby_room_reserved_host_note())).toBeTruthy();
  });
});
