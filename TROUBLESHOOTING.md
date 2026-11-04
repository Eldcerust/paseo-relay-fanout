# Relay Fan-out: if it fails (handoff for another agent)

Read this first, then `README.md` in the same folder. Plugin source: `<path to this repo>`.

## What this is

One Paseo daemon can only register with one relay. The plugin runs a small WebSocket proxy on `127.0.0.1:7733`
inside the daemon. The daemon dials the proxy as if it were its relay, and the proxy opens a matching connection
to every relay in a config file (currently the official relay and a self-hosted one). Traffic stays end-to-end
encrypted; the proxy only forwards frames.

```
phone -> official relay (relay.paseo.sh:443) -+
                                              +-> proxy 127.0.0.1:7733 -> Paseo daemon (0.14.0, desktop-managed)
phone -> home relay (paseo.example.com:443) -+
```

## Where things live (the live machine)

| Thing | Location |
| --- | --- |
| Live daemon home | `C:\Users\you\.paseo` (listens `0.0.0.0:6767`) |
| Daemon config | `C:\Users\you\.paseo\config.json` |
| **Backup from before any change** | `C:\Users\you\.paseo\config.json.bak-before-relay-fanout` |
| Proxy config (relays list) | `C:\Users\you\.paseo\plugin-data\relay-fanout\config.json` |
| Daemon log | `C:\Users\you\.paseo\daemon.log` |
| Plugin source (installed by reference) | `<path to this repo>` |

Intended final daemon settings under `daemon.relay` in `config.json`:

```
enabled: true
endpoint: 127.0.0.1:7733        (the proxy)
useTls: false
publicEndpoint: relay.paseo.sh:443   (only affects pairing links the daemon prints)
publicUseTls: true
```

The proxy's relay list (`plugin-data\relay-fanout\config.json`): `official` = `relay.paseo.sh:443` (TLS),
`home` = `paseo.example.com:443` (TLS). Before the switch the live config had only `"relay": { "enabled": true }`.
As of 2026-11-03 22:23 local the saved preference is **Preferred home** (Priority mode with `home` first), so
`official` is standing by and `home` is the only registered relay. Press **Auto** in the screen's header if that was
not intended.

## Use the right CLI

The `paseo` on PATH in Git Bash is an old npm-global **0.12.0** install and talks to the wrong daemon build.
Use the desktop app's bundled CLI (0.14.0):

```powershell
$p = "C:\Program Files\Paseo\resources\bin\paseo.cmd"     # in Git Bash it is $PASEO_CLI
& $p daemon status          # shows the relay: line the daemon is really using
& $p plugin ls              # relay-fanout should say "running"
& $p plugin logs relay-fanout
```

## Quick diagnosis

1. `& $p daemon status` -> look at the `relay:` line. `endpoint` is `127.0.0.1:7733` if the switch has been applied.
   If it still says `relay.paseo.sh:443`, the switch was not applied or the daemon was not restarted. Nothing is broken, it just is not using the proxy.
2. `& $p plugin ls` -> `relay-fanout` must be `running`. If `failed`, read `& $p plugin logs relay-fanout`.
3. `Invoke-RestMethod http://127.0.0.1:7733/health` -> healthy looks like `daemonConnected: true` and each upstream
   `state: connected`, `ready: true`, plus `preference` and each upstream's `priority.role` (`active`, `standby`,
   `connecting`, `down`). In Auto every relay should be `active`; in Priority the first one should be `active` and
   the rest `standby`. The same status is on the **Relay Fan-out** sidebar screen (dot: green/amber/red).
4. Daemon log lines to grep in `daemon.log`: `relay_control_connected`, `relay_control_disconnected`, `relay_data_connected`. Connection ids look like `official:conn_1` / `home:conn_1`.

## Failure -> cause -> fix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Phones or the app cannot reach the daemon after the restart | Daemon points at the proxy but the plugin is not running | `& $p plugin ls`; if failed, fix per rows below, else **roll back** (next section) |
| Phones paired with the `official` relay cannot reach the daemon, while the sidebar says "Preferred relay home connected" | The saved mode is **Priority** with `home` first, so `official` is deliberately standing by | Open **Relay Fan-out** and press **Auto**, or pair those devices with the `home` link (the globe beside it) |
| Plugin `failed: Plugin process exited` | Port 7733 already in use (`EADDRINUSE` in plugin logs) | `netstat -ano \| findstr :7733`, free the port, then `& $p plugin reload relay-fanout` |
| Plugin `failed: Invalid relay-fanout config ...` | Bad `plugin-data\relay-fanout\config.json` (listen host must be loopback, names `a-z0-9-`, endpoints `host:port`) | Fix the file, `& $p plugin reload relay-fanout` |
| Sidebar says "Daemon not using the proxy" | `daemon.relay.endpoint` is not `127.0.0.1:7733`, or the daemon was not restarted after setting it | Set it (see intended settings), restart the daemon |
| One relay shows `Down` with an error | That relay is unreachable | Check it directly (below). The other relay keeps working; the proxy retries on its own (1s growing to 30s) |
| A healthy relay shows `Standby` | Normal in **Priority** mode: it is deliberately not registered while the first relay serves | Nothing to fix. Press **Auto**, or drag that relay to the top, to change it |
| Headline says "Using fallback relay ..." | The first relay is unavailable, so another relay is carrying traffic | Check the first relay. It is retried every 2 minutes; the fallback is let go 15 seconds after the preferred one is stable |
| The first relay's card says `Retrying` | It was given up on after about 20 seconds without becoming ready, and is tried again every 2 minutes | Check the relay. The next retest is automatic; dragging it away and back does not skip it |
| "Preferred relay is not in the list" | `preference.preferred` names a relay that is no longer in the config (for example after hand-editing) | Press **Auto**, then **Priority** again, or drag a current relay to the top |
| Add relay is refused | The address, port, name or count is invalid: no port with a bare host, unsupported scheme, duplicate endpoint/name, or more than 8 relays | Read the message under the field. `wss://host` or `host:443` is enough; `wss://` and port 443 mean TLS |
| A relay removed from the screen dropped its sessions | Expected. Removing a relay closes its control and data sockets | Re-add it if that was a mistake; the last relay cannot be removed |
| `home` shows "No reply" / `ready: false` | The self-hosted relay accepted the socket but sent no control message (the real daemon would reject it too) | Relay-side problem, see "Relay side". Remove `home` from the proxy config as a stopgap |
| `home` flaps between connected and down | Two upstreams point at the **same** relay (e.g. public name and NetBird IP). A relay keeps one control socket per server id, so each replaces the other | Keep exactly one address per relay |
| Pairing links printed by the daemon contain `127.0.0.1:7733` | `publicEndpoint` / `publicUseTls` not set. `publicEndpoint` silently defaults to `endpoint` | Set `daemon.relay.publicEndpoint relay.paseo.sh:443` and `daemon.relay.publicUseTls true`, restart |
| Sessions drop after about 30s on one relay | Data socket keepalive closed a silent socket. Only happens after that socket answered a ping once; log says `upstream data socket silent` | Usually a real network problem on that path. Check the relay and the path |
| "Request" and "Socket ping" on a relay differ a lot | Normal behind Cloudflare or a tunnel. An edge can answer pings itself, and a tunnel can send a request and a long-lived socket down different routes. Observed on `paseo.example.com`: ping 73 ms / request about 425 ms, then an hour later ping about 400 ms / request 45 to 75 ms. The NetBird address `198.51.100.10:8411` was about 1 ms for both | Read both. Sessions are WebSockets, so the ping is the closer match. If the home relay is slow, consider registering the daemon over the NetBird address (never both addresses of the same relay, see flapping above) |
| Latency stays "Measuring" or shows only "Connect" | The relay has no `/health` route, or never keeps connections alive, so no warm sample exists. Or nobody has the status screen open (nothing is measured then) | Open the Relay Fan-out screen. Check `curl <relay>/health` |
| Latency says "No answer" with `HTTP 503` or `ECONNREFUSED` | The relay's `/health` is failing even if the WebSocket path works, or the relay is unreachable | Check the relay itself (commands above) |
| No Relay Fan-out sidebar entry | Plugin not running, client bundle failed to build, or the row is hidden in Settings > Sidebar | `& $p plugin ls`, `& $p plugin logs relay-fanout` |

Check the relays directly (should print `{"status":"ok","version":"v0.5.0"}` for the self-hosted one):

```powershell
curl.exe -s https://paseo.example.com/health
curl.exe -s http://198.51.100.10:8411/health      # NetBird path
curl.exe -s https://relay.paseo.sh/health         # official
```

## Roll back (puts the daemon back on the official relay directly)

```powershell
$p = "C:\Program Files\Paseo\resources\bin\paseo.cmd"
& $p daemon config unset daemon.relay.endpoint
& $p daemon config unset daemon.relay.useTls
& $p daemon config unset daemon.relay.publicEndpoint
& $p daemon config unset daemon.relay.publicUseTls
& $p daemon restart
```

The plugin can stay installed and idle. To remove it: `& $p plugin disable relay-fanout` (or `plugin remove relay-fanout`).
Last resort: copy `config.json.bak-before-relay-fanout` over `config.json` and restart (this also drops any config changes made since the backup).

## Rules that bit us (do not relearn them)

- **Restarting the daemon stops every running agent, including the agent doing the work.** Hand the restart to the user (a Run card or their terminal) and do not do it from an agent that lives on this daemon.
- Relay endpoint settings are read at daemon start. A config change needs a restart. Plugin source changes need only `& $p plugin reload relay-fanout`.
- The relay list and the preference are the exception: the screen saves them to `plugin-data\relay-fanout\config.json` and applies them to the running proxy immediately, with no restart. Do not hand-edit the file while the plugin is running unless you reload it afterwards, or the screen's next change can overwrite your edit.
- In Priority mode, the proxy has no way to tell a phone which relay to use. It only decides which relays the daemon is registered through. The device still chooses among the relays it knows.
- A plugin's `contribute` must return its cleanup function synchronously. An `async` one fails with "Plugin contribution must return a cleanup function".
- A relay keeps one control socket per server id (newest wins) and one data socket per connection id.
- A session never moves between relays. The app reconnects through another relay, and the daemon resumes the session by client id if that happens within 90 seconds. Frames lost when a path dies are not replayed.
- Never read or print `secretKeyB64` in `daemon-keypair.json`. The plugin only reads the public key.
- Do not add a second `paseo` version to the mix. Always the bundled 0.14.0 CLI.

## Relay side (from the earlier setup work, not re-verified here)

- The self-hosted relay is `zenghongtu/paseo-relay` v0.5.0 in Docker on an LXC container (`192.0.2.10:8411`, NetBird `198.51.100.10:8411`), published through a Cloudflare tunnel as `paseo.example.com`.
- The tunnel's public hostname must point at `http://192.0.2.10:8411`. Earlier it pointed at `http://localhost` (port 80) and returned 502.
- It is managed from `debian@192.0.2.20:/home/debian/Documents/home-vps` (Ansible role `paseo_relay`, playbook `paseo-relay-lxc.yml`, wiki entity `wiki/entities/paseo-relay.md`).
- Before the switch, WebSocket upgrades were confirmed (HTTP 101) on the public, NetBird and official paths.
- The switch was applied on 2026-11-03 (worker restarted about 14:19Z). Right after, the live daemon registered through the proxy and **both** upstreams reported `connected`, `ready: true`, so the self-hosted relay does send a control message. Real sessions were already arriving as `official:conn_...`. Not yet observed: a real client session through `home` (needs a phone or app paired with the `home` link from the Relay Fan-out screen).

## Working on the plugin itself

```
cd <path to this repo>
npm run typecheck      # two programs: server (Node types) and client (React Native types)
npm test               # 224 tests, includes real end-to-end encrypted channels through the proxy
```

Layout: `index.server.ts` (entry), `server/proxy.ts` (the proxy), `server/config.ts`, `server/priority.ts` (which relays stay registered in Priority), `server/relays.ts` + `server/actions.ts` (add, remove, preference), `server/pairing.ts`, `shared/status.ts` and `shared/relay-input.ts` (contracts and address rules), `index.client.tsx` + `client/` (sidebar row and status screen). Test a change on a throwaway daemon (own `--home`, own port, `features.webUi.enabled` to view it in a browser) before touching the live one.
