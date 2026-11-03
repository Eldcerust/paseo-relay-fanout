Relay Fan-out lets one Paseo daemon stay reachable through several relays at the same time, for example the official relay and a relay you host yourself.

A daemon normally registers with a single relay. This plugin runs a small proxy on your machine. The daemon connects to the proxy as if it were its relay, and the proxy opens a matching connection to every relay you list. Each phone or desktop client then connects through whichever relay it paired with. Traffic stays end-to-end encrypted between the client and the daemon. The proxy only forwards the encrypted frames and never sees keys or content.

A Relay Fan-out entry in the sidebar opens a status screen. It shows whether the daemon is using the proxy, whether each relay is connected, for how long and with how many sessions, and the error when a relay is down. Each relay also shows two live round-trip times side by side, the time to answer a request and the time to answer a WebSocket ping, each with its recent best and worst and how many failed, plus the connection time. They can disagree on a relay behind a tunnel or an edge, and the card says so when they do. They are measured from the machine the daemon runs on, requests only while the screen is open and at most once every 5 seconds per relay. Each relay has a Copy link button that produces the pairing link for that relay, to paste under Add host on a phone or another computer. The dot on the sidebar entry summarizes it: green when every relay is connected, amber when some are not, red when none are.

## Setup

The proxy reads `plugin-data/relay-fanout/config.json` inside your Paseo home. Without that file it uses the official relay only. The file lists the relays and the local port, which must be a loopback address:

```json
{
  "listen": { "host": "127.0.0.1", "port": 7733 },
  "upstreams": [
    { "name": "official", "endpoint": "relay.paseo.sh:443" },
    { "name": "home", "endpoint": "relay.example.org:443" }
  ]
}
```

TLS is assumed for port 443 and can be set per relay with `useTls`. The daemon must be pointed at the proxy by setting its relay endpoint to `127.0.0.1:7733` with TLS off, and restarted once. Its public endpoint, which only decides what pairing links the daemon itself prints, stays as it is. Until the daemon uses the proxy, the screen says so and names the setting to change.

## Things to know

- Needs Paseo 0.14.0 or later with plugins enabled.
- While the plugin is stopped or failed, the daemon has no relay path at all. Direct connections keep working.
- The pairing links contain only public data: the daemon's server id, its public key and the relay address. The plugin reads the public key from the daemon's key file and never reads out the secret key.
- `http://127.0.0.1:7733/health` shows the same status as JSON.
- The proxy speaks relay protocol version 2 and rejects anything else. A Paseo release that changes that protocol will need a plugin update.
- Failover is up to the client app. The daemon is registered with every relay at once, but a phone only uses the relay it connects to, and a session never moves between relays on its own. If a relay fails, the app reconnects through another one and the daemon resumes the session if that happens within 90 seconds. Messages in flight when a path fails are not replayed.
- A relay that stops answering is cut off after about 30 seconds so the daemon notices the disconnect.
- A relay that is unreachable is retried with a growing delay, up to 30 seconds, and does not affect the others.
