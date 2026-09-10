# Hosting a DRIFT match on your LAN

A DRIFT match runs on one PC: the *authority host*. Everyone else joins with a
browser. The host PC needs no internet after the first start - the launcher
installs and builds once, then starts offline.

## Starting and stopping

Double-click **Start-DRIFT.cmd** (or run it from a terminal). It:

1. finds Bun (`DRIFT_BUN`, then `bun` on PATH, then `%APPDATA%\npm\node_modules\bun\bin\bun.exe`)
   and prints its version;
2. checks `bun.lock`, `node_modules` and `dist` against the source; only a first run
   or a stale build triggers `bun install --frozen-lockfile` and `bun run build`;
3. refuses to start if a host is already running on the same data folder;
4. starts the host in its own console window, waits for it to report ready, then
   prints the guest address (plus a QR code) and opens the operator page in your browser.

Flags: `-Port <1024-65535>` (default 8080), `-Data <folder>`, `-Adapter <ipv4>` when the
PC has several network cards, `-NoBrowser`, `-NonInteractive`, `-Setup` (prepare and
exit without hosting). `Stop-DRIFT.cmd` asks the host to save and stop; `-Stop` does the
same thing.

Closing the browser tab does **not** stop the host - the match keeps running until you
run `Stop-DRIFT.cmd` or close the host window. If the PC sleeps, guests lose the
connection; wake it and start the launcher again, and they rejoin with the same
address. Guests never install or build anything.

## Two addresses: guests and operator

The launcher prints two different URLs, and they are not interchangeable:

| Address | Who uses it | Example |
| --- | --- | --- |
| `Guests: http://192.168.1.42:8080/` | every other machine on the Wi-Fi | paste into any phone/laptop browser, or scan the QR |
| `Operator: http://127.0.0.1:8080/#op=<token>` | you, on the host PC only | loopback; carries the single-use admin token |

The guest address only ever gives a seat. The `#op=` token is the operator key: it is
what lets you claim the host seat and run the match. It stays on the host machine - the
launcher opens it for you and never prints it. Do not read it out, screenshot it, or
send it to the players.

## How a guest joins

```
  #1  Same Wi-Fi as the host PC
  #2  Scan the QR in the host console   (or type the guest address)
      [##]  [  ]  [##]      phone camera -> http://192.168.1.42:8080/
  #3  Pick a callsign, pick a side
  #4  Wait for the host to launch the match
```

A room code grants admission to an open room; it never grants operator rights. If the
room is full, or the build on the guest's tab does not match the host, the tab says so
before it allocates a seat - reload it once the host has been updated.

## Windows Firewall

The first launch may show a Windows Defender prompt. Allow access on **Private
networks only**, for the Bun/DRIFT executable:

```
  [x] Private networks   <- LAN guests need this
  [ ] Public networks    <- not needed
```

Do not create a blanket "allow all" rule and do not run the launcher as administrator;
the launcher never escalates. If you dismissed the prompt, re-enable it from
*Windows Security > Firewall & network protection > Allow an app through firewall* by
pointing at the same `bun.exe` the launcher printed, on Private only.

## When nobody can connect

- **Wrong Wi-Fi.** Guest and host must be on the same network. A phone on cellular, or
  on a guest SSID, will never reach the host address.
- **AP isolation.** Many public/guest networks block device-to-device traffic. The QR
  scans, the page never loads. Use a private hotspot or a home router instead.
- **VPN or several adapters.** A VPN takes over the default route, so the printed
  address may be on the wrong card. Start with `-Adapter <ipv4>` (the host console can
  list the adapters) or disconnect the VPN, then re-print the QR.
- **Sleep.** A sleeping PC answers nothing: wake it, `Start-DRIFT.cmd` again, and guests
  reconnect to the same address.

## Security: LAN only

LAN HTTP is unencrypted - anyone on that network can read the traffic and the room
codes. Treat a DRIFT match as a trusted-home-network activity.

Hosting for people outside your LAN is a different deployment: it needs an HTTPS/WSS
reverse proxy in front of the host, and the guest address then becomes that public
HTTPS origin. The launcher does not do that for you, and should not be exposed to the
internet directly.
