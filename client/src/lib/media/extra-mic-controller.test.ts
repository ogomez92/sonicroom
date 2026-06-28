import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Device } from "mediasoup-client";
import type { Transport } from "mediasoup-client/types";
import { diffDesiredMics, ExtraMicController } from "./extra-mic-controller";
import { useRoomStore } from "../../stores/room";
import { FakeDevice, type FakeTransport, resetMediasoupMock } from "../../test/mediasoup-mock";
import { mediaController } from "../../test/media-mock";

// The reconcile decision is the genuinely new logic the characterization suite
// doesn't reach (it covers start/stop but not a mono↔stereo flip → restart).
describe("diffDesiredMics", () => {
  const m = (...pairs: Array<[string, boolean]>) => new Map(pairs);

  it("starts newly-desired devices", () => {
    expect(diffDesiredMics(m(), m(["a", false]))).toEqual({
      toStop: [],
      toStart: [["a", false]],
      toRestart: [],
    });
  });

  it("stops devices no longer desired", () => {
    expect(diffDesiredMics(m(["a", false]), m())).toEqual({
      toStop: ["a"],
      toStart: [],
      toRestart: [],
    });
  });

  it("restarts a device whose mono↔stereo flipped", () => {
    expect(diffDesiredMics(m(["a", false]), m(["a", true]))).toEqual({
      toStop: [],
      toStart: [],
      toRestart: [["a", true]],
    });
  });

  it("is a no-op when the selection is unchanged", () => {
    expect(diffDesiredMics(m(["a", true], ["b", false]), m(["a", true], ["b", false]))).toEqual({
      toStop: [],
      toStart: [],
      toRestart: [],
    });
  });

  it("handles a mixed add / remove / flip in one pass", () => {
    const prev = m(["keep", true], ["drop", false], ["flip", false]);
    const desired = m(["keep", true], ["flip", true], ["add", false]);
    expect(diffDesiredMics(prev, desired)).toEqual({
      toStop: ["drop"],
      toStart: [["add", false]],
      toRestart: [["flip", true]],
    });
  });
});

describe("ExtraMicController", () => {
  beforeEach(() => {
    resetMediasoupMock();
    mediaController.reset();
    useRoomStore.getState().reset();
  });

  function makeController() {
    let send: FakeTransport | null = null;
    let device: FakeDevice | null = null;
    const emit = vi.fn().mockResolvedValue({ ok: true });
    const ctrl = new ExtraMicController(
      new AudioContext(),
      useRoomStore,
      emit as unknown as <T>(e: string, d?: unknown) => Promise<T>,
      {
        getSendTransport: () => send as unknown as Transport | null,
        getDevice: () => device as unknown as Device | null,
        getMode: () => "sfu",
      },
    );
    const wireSfu = () => {
      device = new FakeDevice();
      send = device.createSendTransport({});
      return send;
    };
    return {
      ctrl,
      wireSfu,
      get send() {
        return send;
      },
    };
  }

  it("produces every selected device as its own 'mic' producer and maps it back", async () => {
    const { ctrl, wireSfu } = makeController();
    const send = wireSfu();
    useRoomStore.getState().setStreamedMicDeviceIds(["cable-1"]);

    await ctrl.produceAll();

    expect(send.producers).toHaveLength(1);
    expect(send.producers[0].source).toBe("mic");
    expect(send.producers[0].options.stopTracks).toBe(false);
    const pid = send.producers[0].id;
    expect(ctrl.deviceIdForProducer(pid)).toBe("cable-1");

    // teardown closes the producer + forgets the mapping.
    ctrl.teardownAll();
    expect(send.producers[0].closed).toBe(true);
    expect(ctrl.deviceIdForProducer(pid)).toBeNull();
  });

  it("skips the primary mic so the same capture never streams twice", async () => {
    const { ctrl, wireSfu } = makeController();
    const send = wireSfu();
    useRoomStore.getState().setMicDeviceId("cable-1");
    useRoomStore.getState().setStreamedMicDeviceIds(["cable-1", "cable-2"]);

    await ctrl.produceAll();

    // Only cable-2 is produced — cable-1 is the primary voice mic.
    expect(send.producers).toHaveLength(1);
  });
});
