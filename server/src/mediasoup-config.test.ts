import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  announcedAddresses,
  buildListenInfos,
  localInterfaceAddresses,
} from "./mediasoup-config.js";

const noInterfaces = () => ({});

const iface = (address: string, family: "IPv4" | "IPv6", internal = false) =>
  ({ address, family, internal, netmask: "", mac: "00:00:00:00:00:00" }) as never;

describe("buildListenInfos", () => {
  it("keeps the historical single pair when nothing is announced", () => {
    assert.deepEqual(buildListenInfos({}, noInterfaces), [
      { protocol: "udp", ip: "0.0.0.0" },
      { protocol: "udp", ip: "::" },
    ]);
  });

  it("announces one listenInfo per address for a single value", () => {
    assert.deepEqual(buildListenInfos({ ANNOUNCED_IP: "203.0.113.10" }, noInterfaces), [
      { protocol: "udp", ip: "0.0.0.0", announcedAddress: "203.0.113.10" },
      { protocol: "udp", ip: "::" },
    ]);
  });

  it("splits a comma- or space-separated list (public + LAN, the home-NAT case)", () => {
    const infos = buildListenInfos(
      { ANNOUNCED_IP: "203.0.113.10, 192.168.1.50   10.0.0.5" },
      noInterfaces,
    );
    assert.deepEqual(announcedAddresses(infos), ["203.0.113.10", "192.168.1.50", "10.0.0.5"]);
    assert.ok(infos.every((info) => info.protocol === "udp"));
    assert.equal(infos.filter((info) => info.ip === "0.0.0.0").length, 3);
  });

  it("keeps the families separate and tolerates bracketed IPv6", () => {
    const infos = buildListenInfos(
      { ANNOUNCED_IP: "203.0.113.10", ANNOUNCED_IP6: "[2001:db8::1], 2001:db8::2" },
      noInterfaces,
    );
    assert.deepEqual(
      infos.map((info) => [info.ip, info.announcedAddress]),
      [
        ["0.0.0.0", "203.0.113.10"],
        ["::", "2001:db8::1"],
        ["::", "2001:db8::2"],
      ],
    );
  });

  it("deduplicates so a repeated address doesn't burn an extra port per transport", () => {
    const infos = buildListenInfos({ ANNOUNCED_IP: "203.0.113.10,203.0.113.10" }, noInterfaces);
    assert.deepEqual(announcedAddresses(infos), ["203.0.113.10"]);
  });

  it("appends this host's own addresses when ANNOUNCE_LOCAL_IPS is set", () => {
    const interfaces = () => ({
      lo: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
      eth0: [iface("192.168.1.50", "IPv4"), iface("fe80::1", "IPv6"), iface("2001:db8::9", "IPv6")],
    });
    const infos = buildListenInfos(
      { ANNOUNCED_IP: "203.0.113.10", ANNOUNCE_LOCAL_IPS: "true" },
      interfaces,
    );
    // Loopback and IPv6 link-local are never announced.
    assert.deepEqual(announcedAddresses(infos), ["203.0.113.10", "192.168.1.50", "2001:db8::9"]);
  });

  it("ignores local interfaces unless the flag is truthy", () => {
    const interfaces = () => ({ eth0: [iface("192.168.1.50", "IPv4")] });
    assert.deepEqual(announcedAddresses(buildListenInfos({}, interfaces)), []);
    assert.deepEqual(
      announcedAddresses(buildListenInfos({ ANNOUNCE_LOCAL_IPS: "false" }, interfaces)),
      [],
    );
    assert.deepEqual(
      announcedAddresses(buildListenInfos({ ANNOUNCE_LOCAL_IPS: "on" }, interfaces)),
      ["192.168.1.50"],
    );
  });
});

describe("localInterfaceAddresses", () => {
  it("returns only external addresses of the asked-for family", () => {
    const interfaces = () => ({
      lo: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("192.168.1.50", "IPv4"), iface("2001:db8::9", "IPv6")],
      docker0: undefined,
    });
    assert.deepEqual(localInterfaceAddresses("IPv4", interfaces), ["192.168.1.50"]);
    assert.deepEqual(localInterfaceAddresses("IPv6", interfaces), ["2001:db8::9"]);
  });
});
