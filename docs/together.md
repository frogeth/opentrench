# TrenchTogether: share calls with friends

## What a room is

A room is a private channel for your calls. It lives on a relay, a small
server that passes messages between the room's members and cannot read them,
because every message is encrypted on your machine with a key only the invite
carries. Friends join with one link, from anywhere, and nothing on your side
listens on the internet.

## Create a room

1. ⚙ → **Together** → **Create a room**.
2. Give it a name and paste a relay address. There is no official relay: host
   your own ([Host a relay](relay.md), one command) or use a friend's. The
   field is empty the first time and remembers the last relay you used.
   **Check** next to the field asks that relay whether it is up; Create does not, so a relay that
   does not answer shows on the room card instead.
3. Press **Create**. The room appears as a card with a status dot and how many
   members are online.
4. Press **Copy invite** and send the link to your friends however you talk to
   them.

The invite looks like `opentrench://room/<relay-host>/<key>`. The key is the
whole secret: whoever has it is in.

## Join a room

Either click the `opentrench://room/…` link. The desktop app opens Settings →
Together with the invite filled in; press **Join**.

Or paste the invite into **Join a room** and press **Join**. Pasting works on
the web page too.

The invite carries the relay's address, so there is nothing to configure. If
that relay asks for an access code, enter it under **This relay asks for an
access code** before you press Join, or later on the room card when it says
`relay wants an access code`. The code is kept per room, next to its key.

## What travels

Only calls: the token (its address and chain), who called it, in which chat,
and when. On joining, a member sends its calls of the last 24 hours (newest
first, at most 200) so the room catches up; after that, every new call from
one of its own chats, at most once per token every 30 seconds.

Never chat messages. Nothing anyone wrote in a channel leaves your machine.

No prices, market caps, liquidity, volume or holder data either. Each app
prices tokens itself, like any other token on its screen: live from the pool
while the token is on screen, from Dexscreener otherwise.

A call that arrived through a room shows `via <name>` on the card, with the
name the friend set in the Together page. Calls that came `via` someone are
not sent on again, so a room cannot echo.

## Rotate and leave

**Rotate** (the **New invite** button) makes a new key, so a new room id and a
new invite. The old room gets one last notice that it was rotated: every other
member's card shows `invite changed — ask for the new one` and stops
reconnecting. They press **Leave** on that card and join again with the new
link; anyone still holding the old one is out. That is the only way to remove
someone.

**Leave** disconnects from the room and forgets its key on your machine. The
others keep going.

## Same Wi-Fi instead

The older mode is still there, under **Same Wi-Fi instead** on the same page.
It uses no relay: nothing leaves the network.

- Turn on sharing. Your machine announces itself on the local network, and
  friends see you by name under **Nearby** and press **Connect**.
- You get an **Allow / Ignore** prompt with a four-character code shown on
  both screens. Allow does the pairing.
- Not found under Nearby (a VPN, a stricter router)? Copy the **pair by link**
  string and send it over; the other side pastes it. It carries your LAN
  address and port `3211`.

Rooms sit beside this mode, not on top of it. Use both if you like.

## Trust

The relay sees your IP address and how much you send, never a call or a name,
because everything is encrypted with the key in the invite and the relay never
gets that key. Joining a room means trusting its relay's operator with that
much, and no more. Anyone with the invite is in, so treat it like a group
password: share it where only the people you want can read it, and rotate it
if it gets out.

## Troubleshooting

The room card shows one of these next to its dot.

| It says | What to do |
| --- | --- |
| `connecting…` | Wait a few seconds. The app retries on its own, 2 s then up to 15 s apart. |
| `connected` | All good. The number after it is how many members the relay sees right now. |
| `offline · retrying` | The relay is unreachable or your network dropped, and the reason follows. Nothing to do unless it stays that way; then check the relay's address with `https://<host>/` in a browser. |
| `offline · retrying · could not reach <host>` | The address in the invite does not answer. Check it, or ask the person who sent the invite whether the relay is up. A relay that has not been started yet shows this too. |
| `invite changed — ask for the new one` | Someone rotated the room. Your key no longer matches and the app stops reconnecting; press **Leave** and join with the new invite. |
| `this relay needs updating` | The relay runs an older protocol than your app. Whoever hosts it has to pull and redeploy ([Host a relay](relay.md#updating)). |
| `relay wants an access code` | This relay is private. Ask its operator for the code and enter it in the field that appears on the room card. |
| `room is full` | The relay's member limit for this room is reached (50 by default). Someone has to leave, or the operator raises `RELAY_MAX_MEMBERS`. |
| `slow down · retrying` | The relay cut the connection for sending too fast (more than 30 messages a second). The app backs off and reconnects on its own. |
