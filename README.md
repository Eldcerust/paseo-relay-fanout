# Relay Fan-out (Paseo plugin)

Keeps one Paseo daemon registered with several relays at once. See `OVERVIEW.md` for the short version.

```
 phone ──► official relay ─┐
                           ├─► relay-fanout proxy (127.0.0.1:7733) ──► Paseo daemon
 phone ──► home relay ─────┘
```

The daemon dials exactly one relay and has no list setting. The proxy plays the relay for the
daemon and plays the daemon for each real relay. Data frames are forwarded untouched, so the
end-to-end encryption between client and daemon is not affected.

## The sidebar entry

A **Relay Fan-out** row in the sidebar (like Paseo Cafe) opens a status screen. The dot on the row is the
whole plugin's health: green when every relay is connected in Auto, or when the first relay is serving in
Priority; amber when a fallback is carrying traffic or some relay is missing; red when nothing serves or the
plugin does not answer.

The screen shows:

- A headline such as "All 2 relays connected", "Preferred relay home connected" or "Using fallback relay official",
  with the proxy address, the daemon's server id and where the config came from.
- **Relays**: one line per relay. The name is at the top left, the relay's address and port below it, and its round
  trip on the right in large type (the `GET /health` request time; "No answer" in red when it failed). A dot beside the
  name shows its state, and a word under the latency says so when it is not simply connected: `Standby`, `Retrying`,
  `Connecting`, `No reply` or `Not registered`. The socket ping, the connect time and the longer wording are in the
  card's spoken label. See "What the latency numbers mean".
- **Auto / Priority** switch in the header. **Auto** keeps every relay open and lets each device pick the fastest one.
  **Priority** ranks the relays by their order in the list: drag a card by its handle to move it, and the first card is
  the one the daemon is reached through while it works. See "Choosing which relay to use".
- Icons beside each card, outside it: a **globe** copies that relay's pairing link (the link the daemon prints for its
  own relay, built for that relay; paste it under Add host, or open it on the device), a **pencil** edits the relay in
  place (name and address, with the same address rules as adding one), and a **trash** removes it. The trash takes two
  presses: the first turns it red, the second removes the relay, and waiting 5 seconds backs out. The last relay
  cannot be removed.
- **+** in the header adds a relay in a new row: paste `wss://relay.example.org`, `host:port` or a full `https://` URL,
  optionally give it a name. It goes to the bottom of the list. Changes are saved and applied without a restart.
- **Export** copies the current relays, order and proxy address to the clipboard as JSON (and also saves the same text
  as a file beside the config). **Import** opens a popup where you paste a config; it shows what the file holds, and
  replaces the config on a second press. See "Exporting and importing the configuration".
- When the plugin runs but the daemon is still dialing a relay directly, the headline says
  "Daemon not using the proxy" and gives the exact setting to change.

The same state is available from the Command Center ("Open Relay Fan-out") and as JSON at
`http://127.0.0.1:7733/health`. The screen refreshes every 2 seconds while open, the sidebar dot every 5 seconds.

## Choosing which relay to use

The proxy cannot tell a phone which relay to use. The app probes every relay it knows and uses the fastest one that
answers, and that decision belongs to the device. The proxy's lever is **which relays the daemon is reachable through
at any moment**, so the two modes mean:

- **Auto** (the default): every relay stays registered. Each device measures the relays itself and uses the fastest,
  with its own failover. This is the best choice when devices are in different places, because only the device knows
  its own latency.
- **Priority**: the order of the cards is the order of preference. Press **Priority** in the header, then drag cards to
  reorder them; the order is saved as you drop. While the first relay is healthy it is the only one registered; the
  others show **Standby** and are not connected to the daemon. If it fails, the proxy brings up the others and keeps
  the **highest ranked** one that is serving: the second card before the third, however fast each is. A relay that
  stays down is retried once every **2 minutes**, and after it has been stable for 15 seconds the fallbacks stand down
  again. A phone whose session was running through a fallback keeps that session; standing the registration down does
  not cut it. A fallback that has stood down is not tried again until the first relay returns.

A short drop of the first relay (under about 20 seconds) is ridden out without opening the others. A config whose
`preference.preferred` names a relay that does not exist is refused by the config loader, and the screen says so.

The cards can only be dragged in Priority. Assistive technology gets "Move up" and "Move down" actions on the handle;
there is no keyboard shortcut for reordering in the web app.

## What the latency numbers mean

Each relay is measured from the machine the daemon runs on. The large number on a relay's card is the **Request**
figure below. The **Socket ping** and **Connect** figures are in the card's spoken label, and all three, with the recent
average, best and worst and the failure counts, are in the JSON at `http://127.0.0.1:7733/health`. They are **not
combined into one number on purpose**, because on a relay behind a tunnel they can disagree; the card picks the request
because it is the one the proxy can still measure for a relay it has stood down.

- **Request** is the time for the relay to answer `GET /health` over a connection that is kept open. It goes through the
  same address and TLS the daemon uses, so it includes whatever fronts the relay and the relay itself.
- **Socket ping** is a WebSocket ping on the control socket. That is the same kind of path your sessions use (the data
  sockets are WebSockets too), so it is the closer match for how a session feels. An edge such as Cloudflare can answer a ping
  itself, in which case it only measures the distance to the edge.
- **Connect** is the time of a request that had to open a new connection (TCP, TLS and the request). It is kept out of the
  Request figure so connection setup cannot pass for a round trip.

Both round trips keep the last 20 samples. Failed or unanswered ones are counted ("2 of 20 failed") and the reason is shown,
for example `HTTP 503` or `ECONNREFUSED`. The large number turns red and reads "No answer" when the latest request
failed.

What was measured on the real relays while building this:

| Path | Socket ping | Request (`GET /health`) |
| --- | --- | --- |
| `relay.paseo.sh` (official, Cloudflare), twice | 14 ms, 15 ms | 15 ms, 18 ms |
| `198.51.100.10:8411` (NetBird, no Cloudflare) | 1 ms | 1 ms |
| `paseo.example.com` (Cloudflare tunnel to the home relay), first look | 73 ms | 404 to 1242 ms, about 425 ms typical |
| the same hostname, an hour later, live from the daemon | about 400 ms | 45 to 75 ms |

The last two rows disagree **in opposite directions** on the same hostname, so a single number from either one would have
misled. The official relay and the NetBird path agree with themselves. The likely cause on the tunnel path is that it has
more than one route to Cloudflare and the long-lived socket and the individual requests do not always take the same one,
but that was not confirmed. Treat the home relay's tunnel path as variable (tens of milliseconds to over a second).

- **When it measures.** A request to each relay is sent at most every 5 seconds, and only while the status screen is open or
  the proxy's own `/health` is fetched. The sidebar dot never triggers one, and an idle machine sends nothing, which keeps the
  official relay (someone else's service) quiet. The ping comes free with the control socket's keepalive.
- It measures the daemon's side of each relay. It cannot see the phone's own connection to the relay, which is what the
  app itself probes when it picks a connection.
- A relay without a `/health` route, or one that never keeps connections alive, shows only the ping and the connect time.

## What was verified, and what was not

Verified against a real throwaway Paseo 0.14.0 daemon (own `PASEO_HOME`, port 6768) with two
local relays that follow the official relay's server semantics:

- The plugin loads through Paseo's own bundler (including the CommonJS `ws` dependency) and shows `running`.
- The daemon registers with both relays through the proxy.
- The real `paseo` CLI, used as a client through a pairing link for each relay, reached the same daemon
  through both. Both relays minted the same connection id (`conn_1`); the prefix kept them apart.
- Every relay session came up as `securityMode: "protected"` (the daemon's own end-to-end handshake ran through the proxy).
- A plugin reload re-registers both relays in about 3 seconds.
- Failing over between relays: a client connected through relay A, relay A was stopped, and the same client
  (same client id) came in through relay B. The daemon log shows the first hello as `resumed=false` via
  `official:conn_1`, a 90 second reconnect wait when that socket closed, then `resumed=true` via `home:conn_1`.
- A taken port shows the plugin as `failed` (process exited) with the cause in `paseo plugin logs`; an invalid config fails the load with the reason.
- The sidebar row and the screen, in Paseo's own web app served by the throwaway daemon (so your real hosts were
  not touched): live updates when a relay is stopped and started, the "Daemon not using the proxy" state, the
  confirmation toast, and text contrast of 6.2:1 or better in every state.
- The screen at a real 390px wide viewport (the app computes its compact layout itself): no horizontal overflow, the long
  config path wraps, headings shrink, and the rank badge is dropped so a relay's name and address stay readable.
- The globe's pairing link output for the relay that matches the daemon's own public endpoint is byte-for-byte identical to the
  link `paseo daemon pair` prints.
- 275 automated tests (`npm test`), including real end-to-end encrypted channels through the proxy.
  Deliberate bugs (no id prefix, frame types changed, no Origin check, no buffering, "all connected" too eagerly,
  a silent relay counted as healthy, the secret key leaked into a pairing result, four in the data socket keepalive,
  six in the latency code, four in the relay priority wording and four in the priority rules, among others)
  were each caught by the tests.
- The priority rules against fake relays: preferred only, a short drop ridden out, failover to the highest ranked fallback, a ranked fallback given a moment to connect before a lower one wins,
  giving up after the grace period, a retest once per interval, returning and standing the fallbacks down without
  cutting a session that was running through one, changing the preference while running, and adding or removing a
  relay while running.
- Live after the reload on the real daemon: the plugin reconnected the daemon to the proxy in 3 seconds (14:41:21Z to 14:41:24Z),
  and the cards' numbers came from the real relays (official 18 ms request / 15 ms ping, home 45 to 75 ms / about 400 ms).
- The latency numbers against fake relays with a known delay: a relay set to answer in 300 ms reported 300.8 ms, with its
  ping at 21 ms against a 20 ms setting.
- The relay list in Paseo's own web app, against a throwaway 0.14.0 daemon (its own home, three local fake relays at
  7, 42 and 118 ms) and headless Chrome: the one-line cards, the Auto and Priority switch, **dragging** a card from first
  to third (the saved config reordered and the new first relay became the preferred one), an edit in place with a
  missing port refused beside the field and then a rename that kept its position, **+** adding a fourth relay at the
  bottom, the two-press trash, **Export** putting the real config JSON on the clipboard, the globe putting a pairing
  link on the clipboard, and the **Import** popup refusing bad JSON, then checking and replacing the config. The same
  screen at 390px had no horizontal overflow and the form stacked its fields.
- The live plugin after the final reload: `running`, the daemon's pid unchanged, the saved preference preserved, and
  the screen's status fields (`preference`, `priority.role`, `fallbackActive`) present on the real relays.

Not verified:

- **The screen on iOS or Android.** It was checked in the web build at phone width. It uses only React Native
  primitives and the host's own UI kit, but a native device was not used. The sidebar icon (`Waypoints`) rendered in the web build only.
- **Priority mode failing over between the real relays.** The live daemon shows the real home relay active and the
  real official relay standing by in Preferred mode, but taking the real preferred relay down and watching the other
  real relay take over has not been done. That path is tested only with fake relays, and the order-based choice of
  fallback was checked in the automated tests only, not by taking a relay down in the running app.
- **Drag and drop by touch.** The drag was driven with a mouse in the web build. The handle uses `PanResponder` with
  a touch-safe setup (the gesture cannot be taken over by the scroll view), but a finger on a real phone was not used.
- **The data socket keepalive against a real relay.** It is tested against fake relays only. It never closes a socket
  that has not answered a ping at least once, so a relay that ignores pings on data sockets is left alone, but whether
  the official relay answers them was not observed. No CLI command holds a session open without creating an agent, so
  the keepalive was not exercised against the real daemon.
- **A phone.** The app code keeps a list of connections per host and adds a connection when a second
  pairing link arrives (read from the bundled app code), but nobody has paired a phone to two relays.
  How the app chooses between the relays, and whether it fails over, was not examined.
- **A client session through the self-hosted relay (`zenghongtu/paseo-relay`).** The proxy needs every relay to send a
  control message right after the control socket opens, as the official relay does. On the live daemon the self-hosted
  relay did (`home` showed `connected`, `ready: true` over `paseo.example.com:443`), but no phone or app has been
  paired with the `home` link yet, so end-to-end traffic through it is unobserved. If a relay does not send a control
  message, `/health` shows `ready: false` for it and the plugin log says so.
- **The official relay `relay.paseo.sh` in the automated tests.** The tests use a local imitation. On the live daemon the
  daemon log shows sessions arriving through the proxy as `official:conn_...`.

## Setup on a real daemon

Use the Paseo desktop app's bundled CLI. On this machine a plain `paseo` in Git Bash resolves to an old
npm-global 0.12.0 install; `$PASEO_CLI` points at the right one.

1. **Install** (plugins must be enabled, `pluginsEnabled: true`):

   ```
   paseo plugin install <path to this repo>
   ```

2. **Add relays** in one of two ways. On the **Relay Fan-out** screen, press **+**, paste an address and press the
   tick; the screen writes the file and applies the change without a restart. Or write the file yourself at
   `<PASEO_HOME>/plugin-data/relay-fanout/config.json`, starting from `config.example.json`. `useTls` defaults to true
   for port 443 and false otherwise.

3. **Point the daemon at the proxy**, then restart the daemon once (it reads the relay endpoint at start):

   ```
   paseo daemon config set daemon.relay.endpoint 127.0.0.1:7733
   paseo daemon config set daemon.relay.useTls false
   ```

   Leave `daemon.relay.publicEndpoint` and `publicUseTls` alone. They only affect what pairing links contain.

4. **Check** that every relay is connected and ready: open **Relay Fan-out** in the sidebar (the dot should be
   green), or

   ```
   curl http://127.0.0.1:7733/health
   ```

5. **Pair a phone per relay.** On the screen, press the globe beside the relay and paste the link under Add host on the device.
   Repeat for the other relay. Without the screen, `paseo daemon pair` prints a link for the daemon's public endpoint; for another
   relay, copy that link and change `relay.endpoint` (and `relay.useTls`) in the JSON after `#offer=`; the
   payload is base64url-encoded and contains only public data (`v`, `serverId`, `daemonPublicKeyB64`, `relay`).
   The one-liner used in testing:

   ```
   node -e "const u=process.argv[1],o=JSON.parse(Buffer.from(u.split('#offer=')[1],'base64url').toString());o.relay.endpoint=process.argv[2];o.relay.useTls=process.argv[3]==='true';console.log('https://app.paseo.sh/#offer='+Buffer.from(JSON.stringify(o)).toString('base64url'))" "<LINK FROM paseo daemon pair>" paseo.example.com:443 true
   ```

## Rollback

```
paseo plugin disable relay-fanout
paseo daemon config set daemon.relay.endpoint relay.paseo.sh:443
paseo daemon config set daemon.relay.useTls true
```

then restart the daemon. Do the config change **before or together with** disabling the plugin; with the
daemon still pointed at the proxy and the plugin off, the daemon has no relay path.

## Behaviour worth knowing

- The daemon only has a relay path while this plugin is `running`. Direct connections are unaffected.
- The daemon retries a dead proxy with its own backoff (up to 30 s), so a plugin reload costs a few seconds.
- Each relay is retried independently (1 s growing to 30 s). One relay being down does not touch the others.
- **In Auto, every relay is registered.** In **Priority**, only the first relay is registered while it is healthy;
  the others stand by. A first relay that fails is retried every 2 minutes, and the fallbacks are let go only after
  it has been stable for 15 seconds. Changing the order, the mode or the relay list from the screen is saved to
  `plugin-data/relay-fanout/config.json` and applied without a restart.
- **The list order is the priority.** In Priority the first relay is the `preferred` one in the file, and the loader
  moves a `preferred` relay to the front, so a hand-written file and the screen always agree. In Auto the order is
  kept but does not change anything.
- **Removing a relay closes its sessions** and saves the change. If it was first in Priority, the next one is promoted
  and the mode stays Priority. The last relay cannot be removed.
- **Adding a relay** parses the address on both sides. `wss://` and `https://` mean TLS, port 443 means TLS,
  `ws://` and `http://` mean plain, and a bare host without a port is refused so a typo cannot silently dial port 80.
  At most 8 relays. A duplicate endpoint, a duplicate or invalid name, or a missing port is refused with the reason
  beside the field.
- **Editing a relay** renames it, changes its address, or both, and is saved the same way. A rename keeps the relay's
  place in the order. A new address closes that relay's sessions and dials the new one; every other relay is left
  alone. A name or address another relay already uses is refused.
- **Exports are ordinary config files.** **Export** copies the config to the clipboard and also writes
  `exports/relay-fanout-config-<time>.json` beside the config, in the same shape `config.json` uses, so it can be
  dropped in as the config on another daemon. Nothing is overwritten and nothing running changes. **Import** reads a
  file of that shape, checks it, and replaces the config on a second press. See "Exporting and importing the
  configuration".
- **A session stays on the relay its client used.** The proxy never moves a session to another relay and never replays
  frames lost when a path dies (the frames are encrypted per connection and carry no sequence numbers). Recovery is
  the client's: the app probes all of a host's connections every 2 s, switches when the active one is unavailable, and
  the daemon recognises the returning client by its client id. It keeps a disconnected session for 90 s and resumes it;
  after that the client starts a fresh one. Subscriptions are re-created and a fresh snapshot is sent. Agents run in
  the daemon and are not interrupted. A request sent in the instant a path died may need to be sent again; whether
  the app retries it was not traced.
- **Dead paths are cut off.** Upstream data sockets are pinged every 10 s. Once a socket has answered a ping, 30 s of
  silence closes it, which closes the daemon-side socket so the daemon sees the disconnect and starts its 90 s wait.
  Without this a relay that vanished without closing its sockets would leave the session looking connected.
- While the daemon is not connected to the proxy, no relay sees the daemon, so presence stays honest.
- A relay's `sync` is forwarded to the daemon with that relay's ids, prefixed `<name>:<id>`. The daemon treats ids as opaque.
- The proxy listens on loopback only, refuses requests with an `Origin` header or a non-loopback `Host` header,
  and accepts only `role=server`, protocol `v=2`. Any local process can still connect to it, as it could to a relay.
  A second control connection replaces the first, same as on a real relay.
- Plugin logs: `paseo plugin logs relay-fanout`.

## Exporting and importing the configuration

**Export** on the screen copies the running config to the clipboard as JSON. The text holds the relays in priority
order, their TLS setting, the priority mode and the proxy's listen address, in the same shape as `config.json`, so it
can be pasted over `config.json` on this or another daemon and is read back unchanged.

The same text is also written to `plugin-data/relay-fanout/exports/relay-fanout-config-<time>.json`, beside
`config.json`, as a backup, so each press leaves a file behind. The name is an ISO timestamp with the colons removed,
because Windows does not allow them: `relay-fanout-config-2026-11-04T12-30-00Z.json`. Nothing is overwritten; a second
export at the same moment gets `-2`. If the clipboard is not available (some browsers refuse a copy that follows a
network round trip), the message gives the path of the file instead. Exporting touches no relay and changes nothing
running.

**Import** opens a popup. Paste the same text into it and press **Check**: it shows what the file holds (the relay
names, the priority and the proxy address), and nothing is saved until **Replace config** is pressed. A file that
cannot be read is refused with the field that is wrong and what was expected. A successful import replaces the config
file, applies the relay list, the order and the mode at once, and closes the popup.

A file that names a different `listen` address is still saved, but the proxy is already bound, so the new address is
used the next time the plugin starts; the check step says so. Relays and priority change immediately.

## Config reference

| Field | Meaning |
| --- | --- |
| `listen.host` | Must be `127.0.0.1`, `::1` or `localhost`. Default `127.0.0.1`. |
| `listen.port` | Default `7733`. |
| `upstreams[].name` | 1 to 24 characters: lowercase letters, digits, dashes. Unique. Used to prefix connection ids. |
| `upstreams[].endpoint` | `host:port`, with IPv6 hosts in brackets. |
| `upstreams[].useTls` | Optional. Defaults to true when the port is 443. |
| `preference.mode` | Optional. `auto` (default) keeps every relay open; `preferred` is Priority mode: the first relay is kept open while it is healthy and the others take over in list order. |
| `preference.preferred` | Required when the mode is `preferred`. Must name one of the relays; it is moved to the front of `upstreams`. |

The order of `upstreams` is the priority order.

Between 1 and 8 upstreams. `PASEO_RELAY_FANOUT_CONFIG` overrides the config file path.

An export from the screen uses this same shape, with `listen`, `upstreams` and `preference` always written out, so
an exported file can be put in place as `config.json` without editing.

## Development

```
npm install
npm run typecheck
npm test
```

`typecheck` runs two TypeScript programs, because the daemon side (Node types) and the app side (React Native types) clash on globals such as `setTimeout`.
`test/helpers.ts` contains a fake relay that follows the official relay's server semantics and a fake daemon that mirrors the
daemon's relay transport.

| Path | Role |
| --- | --- |
| `index.server.ts` | Daemon entry: starts the proxy, answers the status, pairing and change RPCs. |
| `server/proxy.ts`, `config.ts`, `ids.ts` | The proxy, config loading and saving, connection id prefixing. |
| `server/priority.ts` | The pure rules for which relays to keep registered in Priority mode, with fallbacks taken in list order. |
| `server/relays.ts`, `actions.ts` | Validating an added or edited relay, changing the mode, reordering and removing relays, and committing the result. |
| `server/pairing.ts`, `status.ts` | Per-relay pairing links (public data only), status for the screen. |
| `server/export.ts` | Writing the running config as a `.json` file beside it, without overwriting earlier exports. |
| `server/import.ts` | Reading a pasted file back into a config, and describing it before it is applied. |
| `shared/status.ts`, `relay-input.ts` | The RPC contracts and the address rules shared by both sides. |
| `index.client.tsx` | App entry: the screen, the sidebar row, the Command Center item. |
| `client/view-model.ts` | The wording and colour rules for each state (unit tested, no React). |
| `client/SortableList.tsx` | Drag-and-drop reordering (a `PanResponder` handle; rows have a fixed height so a drop is a division). |
| `client/*.tsx` | The screen, the sidebar row and the status dot. |

## License

MIT. See `LICENSE`.
