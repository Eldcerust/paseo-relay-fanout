import { describe, expect, it } from "vitest";
import { ENDPOINT_PATTERN, RELAY_NAME_PATTERN, parseRelayAddress, suggestRelayName } from "../shared/relay-input";

describe("parseRelayAddress", () => {
  it.each([
    ["wss://paseo.example.com", "paseo.example.com:443", true],
    ["https://relay.example.org/ws", "relay.example.org:443", true],
    ["wss://relay.example.org:8443/ws?x=1#frag", "relay.example.org:8443", true],
    ["ws://198.51.100.10:8411", "198.51.100.10:8411", false],
    ["http://192.0.2.10:8411/health", "192.0.2.10:8411", false],
    ["ws://relay.example.org", "relay.example.org:80", false],
    ["relay.paseo.sh:443", "relay.paseo.sh:443", true],
    ["192.0.2.10:8411", "192.0.2.10:8411", false],
    ["Relay.Example.ORG:443", "relay.example.org:443", true],
    ["[fd00::66]:8411", "[fd00::66]:8411", false],
    ["wss://[fd00::66]/ws", "[fd00::66]:443", true],
    ["  wss://paseo.example.com  ", "paseo.example.com:443", true],
    ["relay.example.org:0443", "relay.example.org:443", true],
  ])("reads %j as %s (TLS %s)", (input, endpoint, useTls) => {
    expect(parseRelayAddress(input)).toEqual({ ok: true, endpoint, useTls });
  });

  it.each([
    ["", /Enter/],
    ["   ", /Enter/],
    ["paseo.example.com", /port/],
    ["relay example.org:443", /spaces/],
    ["ftp://relay.example.org:21", /wss:\/\//],
    ["wss://user:secret@relay.example.org", /user name/],
    ["relay.example.org:99999", /between 1 and 65535/],
    ["wss://relay.example.org:0", /between 1 and 65535/],
    ["wss://", /address/],
    ["wss://:443", /address/],
    ["relay.example.org:abc", /port/],
  ])("refuses %j", (input, message) => {
    const result = parseRelayAddress(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });

  it("produces endpoints the daemon's own pattern accepts", () => {
    for (const input of ["wss://paseo.example.com", "ws://198.51.100.10:8411", "wss://[fd00::66]/ws", "relay.paseo.sh:443"]) {
      const result = parseRelayAddress(input);
      expect(result.ok && ENDPOINT_PATTERN.test(result.endpoint), input).toBe(true);
    }
  });
});

describe("suggestRelayName", () => {
  it.each([
    ["paseo.example.com:443", "paseo"],
    ["relay.paseo.sh:443", "relay"],
    ["198.51.100.10:8411", "relay"],
    ["[fd00::66]:8411", "relay"],
    ["My_Host.example.org:443", "my-host"],
  ])("names %s %s", (endpoint, name) => {
    expect(suggestRelayName(endpoint, [])).toBe(name);
  });

  it("makes the name unique and always valid", () => {
    expect(suggestRelayName("relay.paseo.sh:443", ["relay", "relay-2"])).toBe("relay-3");
    expect(RELAY_NAME_PATTERN.test(suggestRelayName("a-very-long-hostname-that-goes-on-and-on.example.org:443", []))).toBe(true);
    expect(RELAY_NAME_PATTERN.test(suggestRelayName("---.example.org:443", []))).toBe(true);
  });
});
