import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
// Side-effect import first: applies any ?lang= override before anything reads
// the locale (the store's initializer calls getLocale() at module load).
import "./lib/i18n";
import { useRoomStore } from "./stores/room";
import { Lobby } from "./components/Lobby";
import { Room } from "./components/Room";
import "./index.css";

// Treat a bare /<name> as a shortcut for /room/<name>, keeping ?query and #hash
// so deep-link params (?displayName, ?public, ?p2p, ?lang) still apply. Only a
// single path segment (not already "room") redirects; anything else falls back
// to the lobby — which also prevents a redirect loop on unmatched /room/* paths.
function RoomRedirect() {
  const { pathname, search, hash } = useLocation();
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] !== "room") {
    return <Navigate to={`/room/${segments[0]}${search}${hash}`} replace />;
  }
  return <Navigate to={{ pathname: "/", search }} replace />;
}

function App() {
  // Subscribe to the active locale so changing language re-renders the whole
  // tree in place — every m.*() re-evaluates — WITHOUT remounting, so an active
  // call survives a mid-session language switch.
  useRoomStore((s) => s.locale);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:roomName" element={<Room />} />
        <Route path="*" element={<RoomRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
