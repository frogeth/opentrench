# Host a relay

## What a relay does

A relay is the server side of a TrenchTogether room. It is a dumb fan-out: it
takes each message a member sends and passes it to the room's other members.
It only ever carries ciphertext. Every message is encrypted on the sender's
machine with the key from the invite, and that key never reaches the relay.

It is one Node process with no database. Rooms live in memory, plus one JSON
file per room on disk if you give it a data directory, so a restart keeps the
last day of messages and a friend who joins late still catches up.

Your invite carries your relay's address; friends configure nothing. Create a
room with your relay in the relay field, copy the invite, and everyone who
joins with it lands on your relay.

The app ships a default relay address prefilled in the create form. Hosting
your own is a few commands and means nobody but you sees your circle's
traffic.

The code is in [`relay/`](../relay/) in the repo. Node 22.

## Fly.io

The shipped `fly.toml` asks for 256 MB in one region and mounts a volume for
the room buffers. From a checkout of the repo:

```sh
cd relay
fly launch --copy-config --yes
fly volumes create relay_data --size 1
fly deploy
```

`fly launch` picks an app name (or change `app` in `fly.toml` first). Your
relay's address is then `wss://<app>.fly.dev`. Paste that in the relay field
when you create a room.

To make it private, set the access code before deploying:

```sh
fly secrets set RELAY_ACCESS_CODE=<something long>
```

`fly.toml` already sets `RELAY_TRUST_PROXY=1`, which Fly needs for the per-IP
limits to see real client addresses.

## Docker

```sh
docker build -t opentrench-relay ./relay
docker run -d --name relay -p 8080:8080 -v relay-data:/data opentrench-relay
```

The image keeps its room files in `/data`; the named volume keeps them across
restarts. Add `-e RELAY_ACCESS_CODE=<code>` to make it private. The app
connects over `wss://`, so put a TLS proxy in front (see the Caddyfile below,
pointed at port 8080) and use `wss://<your host>` as the address.

## Any Node host behind Caddy

Build and run:

```sh
npm ci -w relay
npm run build -w relay
PORT=8080 RELAY_DATA_DIR=./data node relay/dist/index.js
```

Run it under whatever keeps processes alive on your host (systemd, pm2, a
screen session). Then a Caddyfile, complete; Caddy fetches the certificate
itself:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

`caddy run` with that file, point the DNS name at the host, and the relay's
address is `wss://relay.example.com`. Behind Caddy or any other proxy that
sets `x-forwarded-for`, start the relay with `RELAY_TRUST_PROXY=1`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on (all interfaces). |
| `RELAY_ACCESS_CODE` | unset | When set, only apps that know this code can create or join rooms here. For a relay private to your circle. |
| `RELAY_MAX_ROOMS` | `1000` | Rooms the relay will hold at once. |
| `RELAY_MAX_MEMBERS` | `50` | Members per room. |
| `RELAY_DATA_DIR` | unset | Directory for one `<room>.json` per room; unset keeps buffers in memory only, so a restart loses them. |
| `RELAY_BUFFER_HOURS` | `24` | How long a room keeps its recent messages for late joiners (also capped at 2000 messages). |
| `RELAY_TRUST_PROXY` | `0` | `1` to take the client address from `fly-client-ip` or the last `x-forwarded-for` entry for the per-IP limits. Turn it on only behind a proxy that overwrites or appends that header itself (Fly does; the shipped `fly.toml` sets it). Off, the relay uses the socket address. |

Other limits are fixed: a message is at most 64 KB, a member may send 30
messages a second, a room with no member for 7 days is dropped, file included.

## The access code

Without a code, anyone who knows your relay's address can create rooms on it.
They still cannot read anyone else's room, but they use your machine. Set
`RELAY_ACCESS_CODE` to close that: the relay then refuses every connection
that does not carry the code.

Give the code to your friends alongside the invite. When they create or join a
room on your relay, the app asks for the code and remembers it for that relay.
Without it the room card says `relay wants an access code`.

## Checking it works

```sh
curl https://<host>/
```

answers

```json
{"name":"opentrench-relay","v":1,"rooms":0}
```

`rooms` is how many rooms the relay holds right now. The app calls the same
address to confirm that what you typed in the relay field is a relay before it
creates or joins a room there.

## Updating

Pull the repo, rebuild, redeploy: `fly deploy` on Fly, `docker build` and a
new `docker run` for Docker, `npm run build -w relay` and a restart on a Node
host. Room files on the volume survive.

Members are told to update only if the protocol version moves. The app then
shows `this relay needs updating` on the room card until you redeploy. A relay
newer than an app refuses that app with `too-new`, so update relays first.

## What the operator can and cannot see

Can see: each member's IP address, its member id (a random value the app made
once at install; it is not a name), when it connects, how many messages it
sends and how big they are, and how many rooms exist.

Cannot see: any call, token, chat name or display name. Those are inside the
ciphertext, and the key stays in the invite. The relay does not learn who is
in a room beyond the member ids, and it cannot tell one room's purpose from
another's.

Anyone who gets the invite can join the room and read everything in it. The
relay cannot stop that; only rotating the room can.
