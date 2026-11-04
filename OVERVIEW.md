Relay Fan-out lets one Paseo daemon stay reachable through several relays at the same time, for example the official relay and a relay you host yourself.

A daemon normally registers with a single relay. This plugin runs a small proxy on your machine. The daemon connects to the proxy as if it were its relay, and the proxy opens a matching connection to every relay you list. Each phone or desktop client then connects through whichever relay it paired with. Traffic stays end-to-end encrypted between the client and the daemon. The proxy only forwards the encrypted frames and never sees keys or content.

A Relay Fan-out entry in the sidebar opens a status screen. It shows whether the daemon is using the proxy, whether each relay is connected, for how long and with how many sessions, and the error when a relay is down. Each relay is one line with its name, its address and port, and a large live round-trip time, the time to answer a request. A WebSocket ping and the connection time are measured as well and are in the card's spoken label; they can disagree with the request on a relay behind a tunnel or an edge. They are measured from the machine the daemon runs on, requests only while the screen is open and at most once every 5 seconds per relay. A globe icon beside each relay copies the pairing link for that relay, to paste under Add host on a phone or another computer.

The screen also chooses how relays are used. **Auto** keeps every relay connected and lets each device use the fastest relay it can reach. **Priority** ranks the relays by the order of the cards, which you change by dragging: while the first relay is healthy it is the only one registered and the others stand by, and if it fails the next ones take over in list order; the first relay is retried every 2 minutes. A **+** in the header adds a relay in a new row, a pencil beside a card edits it in place, and a trash icon removes it on a second press, so the config file is not the only way to change the list. **Export** copies the current list, order and listen address to the clipboard (and saves the same text as a timestamped file beside the config), while **Import** opens a popup that takes such a file back, checks it, and replaces the config on a second press. The dot on the sidebar entry summarizes the result: green when every relay is connected in Auto or the first relay is serving, amber when a fallback is carrying traffic or a relay is missing, red when nothing serves.

## Setup

The proxy reads `plugin-data/relay-fanout/config.json` inside your Paseo home. Without that file it uses the official relay only. The file lists the relays, the local port, which must be a loopback address, and optionally the preference:

```json
{
  "listen": { "host": "127.0.0.1", "port": 7733 },
  "upstreams": [
    { "name": "official", "endpoint": "relay.paseo.sh:443" },
    { "name": "home", "endpoint": "relay.example.org:443" }
  ],
  "preference": { "mode": "auto" }
}
```

For Priority mode, use `{ "mode": "preferred", "preferred": "home" }`; the order of `upstreams` is the priority and `home` is moved to the front. The screen writes this file when you switch mode, drag, add, edit or remove, so hand-editing is optional. TLS is assumed for port 443 and can be set per relay with `useTls`. The daemon must be pointed at the proxy by setting its relay endpoint to `127.0.0.1:7733` with TLS off, and restarted once. Its public endpoint, which only decides what pairing links the daemon itself prints, stays as it is. Until the daemon uses the proxy, the screen says so and names the setting to change.

## Things to know

- Needs Paseo 0.14.0 or later with plugins enabled.
- While the plugin is stopped or failed, the daemon has no relay path at all. Direct connections keep working.
- The pairing links contain only public data: the daemon's server id, its public key and the relay address. The plugin reads the public key from the daemon's key file and never reads out the secret key.
- `http://127.0.0.1:7733/health` shows the same status as JSON.
- The proxy speaks relay protocol version 2 and rejects anything else. A Paseo release that changes that protocol will need a plugin update.
- Failover is up to the client app. In Auto the daemon is registered with every relay at once, but a phone only uses the relay it connects to, and a session never moves between relays on its own. If a relay fails, the app reconnects through another one and the daemon resumes the session if that happens within 90 seconds. Messages in flight when a path fails are not replayed.
- In Priority mode the proxy keeps only the first relay registered while it is healthy. If it fails, the highest ranked healthy fallback is brought up (the second card before the third, whatever their speeds), the first relay is retried every 2 minutes, and the fallback is stood down after the first one has been stable for 15 seconds. A session already running through the fallback is not cut when that happens.
- Adding or removing a relay from the screen is saved to the config and applied without a restart. Removing a relay closes its sessions; the last relay cannot be removed, and removing the first one in Priority promotes the next and stays in Priority.
- **Export** copies the config to the clipboard and also writes `plugin-data/relay-fanout/exports/relay-fanout-config-<time>.json` with the same shape as `config.json`, so it can be pasted over the config on another daemon. Earlier exports are kept and nothing running changes.
- **Import** opens a popup and reads a pasted file of that shape. It shows the relays, priority and proxy address before anything is saved, refuses a file it cannot read with the reason, and replaces the config on a second press. A file that moves the `listen` address is saved, but the proxy keeps its bound address until the next plugin start.
- A relay that stops answering is cut off after about 30 seconds so the daemon notices the disconnect.
- A relay that is unreachable is retried with a growing delay, up to 30 seconds, and does not affect the others.
