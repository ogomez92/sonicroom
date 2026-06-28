import { describe, it, expect, beforeEach } from "vitest";
import type { Device } from "mediasoup-client";
import type { Transport } from "mediasoup-client/types";
import { OutgoingAudioGraph } from "./outgoing-graph";
import { useRoomStore } from "../../stores/room";
import { FakeDevice, type FakeTransport, resetMediasoupMock } from "../../test/mediasoup-mock";

// Drive the graph directly with the mediasoup fakes (no renderHook). The setup
// file installs the Web Audio / Audio fakes globally.
describe("OutgoingAudioGraph", () => {
  beforeEach(() => {
    resetMediasoupMock();
    useRoomStore.getState().reset();
  });

  // Lazily supply the SFU send transport + device so a test can build the graph
  // before they exist, then wire them in before producing.
  function makeGraph() {
    let send: FakeTransport | null = null;
    let device: FakeDevice | null = null;
    const graph = new OutgoingAudioGraph(new AudioContext(), useRoomStore, {
      getSendTransport: () => send as unknown as Transport | null,
      getDevice: () => device as unknown as Device | null,
    });
    const wireSfu = () => {
      device = new FakeDevice();
      send = device.createSendTransport({});
      return send;
    };
    return { graph, wireSfu };
  }

  const fakeTrack = (label = "") =>
    ({ label, kind: "audio", stop() {} }) as unknown as MediaStreamTrack;

  it("builds the outgoing chain on ensure() and exposes the processed track", () => {
    const { graph } = makeGraph();
    graph.ensure();
    expect(graph.outTrack).toBeDefined();
    expect(graph.outStream).toBeDefined();
  });

  it("persists the mic gain to the store", () => {
    const { graph } = makeGraph();
    graph.setMicGain(2.5);
    expect(useRoomStore.getState().micGain).toBe(2.5);
  });

  it("persists the stream monitor volume to the store", () => {
    const { graph } = makeGraph();
    graph.setStreamMonitorVolume(0.3);
    expect(useRoomStore.getState().streamMonitorVolume).toBe(0.3);
  });

  it("produces the share dest as a stereo 256k 'share' track titled by the capture", async () => {
    const { graph, wireSfu } = makeGraph();
    const send = wireSfu();
    const track = fakeTrack("System Audio");
    const displayStream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;

    graph.attachShare([track], displayStream);
    await graph.produceShare();

    expect(send.producers).toHaveLength(1);
    const p = send.producers[0];
    expect(p.source).toBe("share");
    expect(p.options.codecOptions?.opusStereo).toBe(true);
    expect(p.options.codecOptions?.opusMaxAverageBitrate).toBe(256000);
    expect(p.options.stopTracks).toBe(false);
    expect(p.options.appData?.title).toBe("System Audio");

    // Idempotent: a second produce while one is live is a no-op.
    await graph.produceShare();
    expect(send.producers).toHaveLength(1);
  });

  it("produces the file dest as a 'file' track titled from the store's file name", async () => {
    const { graph, wireSfu } = makeGraph();
    const send = wireSfu();
    useRoomStore.getState().setFileStream("song.mp3");

    graph.connectFileElement(new Audio());
    await graph.produceFile();

    expect(send.producers).toHaveLength(1);
    const p = send.producers[0];
    expect(p.source).toBe("file");
    expect(p.options.appData?.title).toBe("song.mp3");
    expect(p.options.stopTracks).toBe(false);
  });

  it("closeProducers() closes both side producers without rebuilding the nodes", async () => {
    const { graph, wireSfu } = makeGraph();
    const send = wireSfu();
    useRoomStore.getState().setFileStream("a.mp3");
    graph.connectFileElement(new Audio());
    await graph.produceFile();
    expect(send.producers[0].closed).toBe(false);

    graph.closeProducers();
    expect(send.producers[0].closed).toBe(true);
    // fileDest survives (stopTracks:false), so a re-produce makes a fresh producer.
    await graph.produceFile();
    expect(send.producers).toHaveLength(2);
  });
});
