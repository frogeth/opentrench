# opentrench relay

The relay is the server side of TrenchTogether rooms: a dumb fan-out that passes each room's messages to the room's other members. It only ever carries ciphertext, encrypted on each member's machine with a key that lives in the invite and never reaches the relay. It is one Node process with no database: memory plus an optional JSON file per room so a restart keeps the last day of calls.

Your invite carries your relay's address; friends configure nothing.

## Hosting

**Fly.io** (the shipped `fly.toml`: 256 MB, one region, a volume for the room buffers)

```sh
cd relay && fly launch --copy-config --yes && fly volumes create relay_data --size 1 && fly deploy
```

**Docker**

```sh
docker build -t opentrench-relay ./relay && docker run -d -p 8080:8080 -v relay-data:/data opentrench-relay
```

**Any Node host**, behind a TLS proxy (the app connects over `wss://`)

```sh
npm ci -w relay && npm run build -w relay && PORT=8080 RELAY_DATA_DIR=./data node relay/dist/index.js
```

A complete Caddyfile for that:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

`GET /` answers `{"name":"opentrench-relay","v":1,"rooms":<n>}`: use it as the health check, and the app uses it to confirm an address is a relay before joining.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on (all interfaces). |
| `RELAY_ACCESS_CODE` | unset | When set, only apps configured with this code can join rooms here. For a relay private to your circle. |
| `RELAY_MAX_ROOMS` | `1000` | Rooms the relay will hold at once. |
| `RELAY_MAX_MEMBERS` | `50` | Members per room. |
| `RELAY_DATA_DIR` | unset | Directory for one `<room>.json` per room; unset keeps buffers in memory only. |
| `RELAY_BUFFER_HOURS` | `24` | How long a room keeps its recent messages for late joiners (also capped at 2000 messages). |
| `RELAY_TRUST_PROXY` | `0` | `1` to take the client address from `fly-client-ip` or the last `x-forwarded-for` entry for the per-IP hello limit. Turn it on only behind a proxy that overwrites or appends that header itself (Fly does; the shipped `fly.toml` sets it). Off, the relay uses the socket address. |

## What the operator sees

IPs, member ids and traffic volume: yes. Calls, names, tokens: no, they are inside the ciphertext. A room nobody has visited for 7 days is dropped, buffer and file included.

## Protocol v1

WebSocket at `/v1`, JSON text frames. First frame `{"t":"hello","v":1,"room","member","access"?}`, then `{"t":"msg","body"}`. The relay answers `welcome`, `msg`, `presence` and, on any violation, `{"t":"error","code"}` followed by a close with a code that names the reason: `4001` too-old, `4002` too-new, `4003` access, `4004` full (room or relay), `4005` rate, `4006` bad frame. Details in `src/relay.ts`.
