/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * opentrench bridge — a Vencord user plugin (https://github.com/frogeth/opentrench).
 *
 * Lets opentrench read and send Discord messages through THIS client instead of a
 * separate self-bot session. It opens a WebSocket to the opentrench backend on
 * localhost and: tells it who you are, your servers, channels and roles; forwards
 * new messages, edits, deletes and reactions from watched channels; performs sends,
 * reactions and history reads on request with Discord's own client functions.
 * It never reads or transmits your token.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, GuildChannelStore, GuildMemberStore, GuildRoleStore, GuildStore, RestAPI, SnowflakeUtils, UserStore } from "@webpack/common";

const ReactionActions = findByPropsLazy("addReaction", "removeReaction");
/** Discord's upload class (the same one its own composer uses) */
const CloudUpload: any = findLazy(m => m.prototype?.trackUploadFinished);

const VERSION = 1;

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Port the opentrench backend listens on (the web page's port, 3210 by default)",
        default: 3210,
    },
});

type Json = Record<string, any>;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let helloTimer: ReturnType<typeof setTimeout> | null = null;
let enabled = false;
let watched = new Set<string>();
const subscriptions: [string, (e: any) => void][] = [];

const log = (...a: unknown[]) => console.log("[opentrench]", ...a);

function send(obj: Json) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function rolesOf(guildId: string): { id: string; name: string; }[] {
    const rs: any = GuildRoleStore;
    let roles: any = rs?.getRolesSnapshot?.(guildId) ?? rs?.getRoles?.(guildId) ?? (GuildStore as any).getRoles?.(guildId) ?? {};
    if (roles && !Array.isArray(roles)) roles = Object.values(roles);
    return (roles as any[]).filter(r => r?.id).map(r => ({ id: String(r.id), name: String(r.name ?? "role") }));
}

/** Everything opentrench needs to name and scope things: you, your servers, their channels and roles. */
function hello() {
    const me: any = UserStore.getCurrentUser();
    if (!me) return;
    const guilds = Object.values(GuildStore.getGuilds() as Record<string, any>).map(g => {
        const chans: any = (GuildChannelStore as any)?.getChannels?.(g.id) ?? {};
        const selectable: any[] = (chans.SELECTABLE ?? []).map((x: any) => x.channel ?? x);
        return {
            id: String(g.id),
            name: String(g.name ?? "Unknown"),
            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : undefined,
            roles: rolesOf(String(g.id)),
            myRoles: ((GuildMemberStore.getMember(g.id, me.id) as any)?.roles ?? []).map(String),
            channels: selectable
                .filter(c => c && (c.type === 0 || c.type === 5))
                .map(c => ({
                    id: String(c.id),
                    name: String(c.name ?? c.id),
                    type: Number(c.type),
                    position: Number(c.position ?? 0),
                    category: c.parent_id ? (ChannelStore.getChannel(c.parent_id) as any)?.name : undefined,
                })),
        };
    });
    send({
        t: "hello",
        version: VERSION,
        user: { id: String(me.id), username: String(me.username), globalName: me.globalName ?? undefined, avatar: me.avatar ?? undefined },
        guilds,
    });
}

const helloSoon = () => {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(hello, 1500);
};

async function handleRequest(req: Json) {
    const { id, op } = req;
    try {
        let result: unknown;
        if (op === "send") {
            const extra: Json = {};
            if (req.replyTo) extra.messageReference = { channel_id: String(req.channelId), message_id: String(req.replyTo) };
            const res: any = await sendMessage(String(req.channelId), { content: String(req.content ?? "") }, undefined, extra);
            result = res?.body ?? res ?? null;
        } else if (op === "sendFile") {
            // an image pasted into opentrench: upload it the way the client does, then post the message
            const bytes = Uint8Array.from(atob(String(req.data ?? "")), c => c.charCodeAt(0));
            const file = new File([bytes], String(req.name || "image.png"), { type: String(req.mime || "application/octet-stream") });
            const channelId = String(req.channelId);
            const upload = new CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId, false, 0);
            await new Promise<void>((resolve, reject) => {
                upload.on("complete", () => resolve());
                upload.on("error", (e: any) => reject(new Error(String(e?.message ?? e ?? "upload failed"))));
                upload.upload();
            });
            const res: any = await RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content: String(req.content ?? ""),
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
                    message_reference: req.replyTo ? { channel_id: channelId, message_id: String(req.replyTo) } : null,
                },
            });
            result = res?.body ?? null;
        } else if (op === "react") {
            const emoji = { id: req.emoji?.id ?? null, name: String(req.emoji?.name ?? ""), animated: !!req.emoji?.animated };
            if (req.on) await ReactionActions.addReaction(String(req.channelId), String(req.messageId), emoji);
            else await ReactionActions.removeReaction(String(req.channelId), String(req.messageId), emoji);
            result = true;
        } else if (op === "history") {
            const res: any = await RestAPI.get({ url: Constants.Endpoints.MESSAGES(String(req.channelId)), query: { limit: Math.min(100, Number(req.limit) || 50) }, retries: 1 });
            result = res?.body ?? [];
        } else if (op === "members") {
            // People this client already knows about, named the way the feed names them
            // (guild nickname first) so a favorite added from here matches their messages.
            const q = String(req.q ?? "").toLowerCase();
            const onlyGuild = req.guildId ? String(req.guildId) : undefined;
            const limit = Math.min(500, Number(req.limit) || 12);
            const out: Json[] = [];
            const seen = new Set<string>();
            const push = (user: any, nick: string | undefined, guild: string) => {
                if (!user || out.length >= limit) return;
                const name = nick || user.globalName || user.username;
                if (!name || !String(name).toLowerCase().includes(q)) return;
                const key = `${user.id}:${name}`;
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ name: String(name), avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : undefined, guild });
            };
            const guilds = Object.values(GuildStore.getGuilds() as Record<string, any>).filter(g => !onlyGuild || String(g.id) === onlyGuild);
            for (const g of guilds) {
                if (out.length >= limit) break;
                const members: any[] = (GuildMemberStore as any).getMembers?.(g.id) ?? [];
                for (const m of members) push(UserStore.getUser(m.userId), m.nick, String(g.name ?? ""));
            }
            if (!onlyGuild && out.length < limit) {
                const users: any = (UserStore as any).getUsers?.() ?? {};
                for (const u of Object.values(users) as any[]) push(u, undefined, "Discord");
            }
            result = out;
        } else if (op === "hello") {
            hello();
            result = true;
        } else if (op === "watch") {
            watched = new Set((req.channels ?? []).map(String));
            result = true;
        } else throw new Error(`unknown op ${op}`);
        if (id !== undefined) send({ t: "reply", id, ok: true, result });
    } catch (e: any) {
        log("request failed", op, e);
        if (id !== undefined) send({ t: "reply", id, ok: false, error: String(e?.message ?? e) });
    }
}

function connect() {
    if (!enabled || ws) return;
    const url = `ws://127.0.0.1:${settings.store.port || 3210}/bridge`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
        log("connected", url);
        hello();
    };
    sock.onmessage = ev => {
        let msg: Json;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.t === "req") void handleRequest(msg);
        else if (msg.t === "watch") watched = new Set((msg.channels ?? []).map(String));
    };
    sock.onclose = () => {
        if (ws === sock) ws = null;
        if (enabled) reconnectTimer = setTimeout(connect, 4000);
    };
    sock.onerror = () => sock.close();
}

function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const s = ws;
    ws = null;
    s?.close();
}

const inWatched = (channelId: unknown) => watched.has(String(channelId));

function subscribe(type: string, fn: (e: any) => void) {
    FluxDispatcher.subscribe(type as any, fn);
    subscriptions.push([type, fn]);
}

export default definePlugin({
    name: "OpentrenchBridge",
    description: "Feeds opentrench from this Discord client (no token, no self-bot) and lets it send through it.",
    authors: [Devs.Ven],
    settings,

    start() {
        enabled = true;
        subscribe("MESSAGE_CREATE", (e: any) => {
            if (e.optimistic || !e.message || !inWatched(e.message.channel_id ?? e.channelId)) return;
            send({ t: "message", d: e.message });
        });
        subscribe("MESSAGE_UPDATE", (e: any) => {
            if (!e.message || !inWatched(e.message.channel_id ?? e.channelId)) return;
            send({ t: "messageUpdate", d: e.message });
        });
        subscribe("MESSAGE_DELETE", (e: any) => {
            if (!inWatched(e.channelId)) return;
            send({ t: "messageDelete", d: { id: String(e.id), channel_id: String(e.channelId) } });
        });
        const reaction = (delta: 1 | -1) => (e: any) => {
            if (e.optimistic || !inWatched(e.channelId)) return;
            send({ t: "reaction", delta, d: { channel_id: String(e.channelId), message_id: String(e.messageId), user_id: String(e.userId ?? ""), emoji: e.emoji } });
        };
        subscribe("MESSAGE_REACTION_ADD", reaction(1));
        subscribe("MESSAGE_REACTION_REMOVE", reaction(-1));
        for (const t of ["GUILD_CREATE", "GUILD_DELETE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "GUILD_ROLE_UPDATE", "GUILD_MEMBER_UPDATE"]) subscribe(t, helloSoon);
        connect();
    },

    stop() {
        enabled = false;
        for (const [t, fn] of subscriptions) FluxDispatcher.unsubscribe(t as any, fn);
        subscriptions.length = 0;
        disconnect();
    },
});
