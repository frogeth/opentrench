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
 * reactions, history reads and slash commands on request with Discord's own client functions.
 * It never reads or transmits your token.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, GuildChannelStore, GuildMemberStore, GuildRoleStore, GuildStore, RestAPI, SnowflakeUtils, UserStore } from "@webpack/common";

const ReactionActions = findByPropsLazy("addReaction", "removeReaction");
/** the gateway session this client is on; an interaction names it so the reply comes back here */
const SessionInfo: any = findByPropsLazy("getSessionId");
/** slash commands seen in searches, by id, so running one sends the full definition the way the client does */
const commandCache = new Map<string, any>();
/** Discord's upload class (the same one its own composer uses) */
const CloudUpload: any = findLazy(m => m.prototype?.trackUploadFinished);

const VERSION = 2;

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
    // DMs and group DMs, so they can be watched like any channel
    const priv: any[] = (ChannelStore as any).getSortedPrivateChannels?.() ?? Object.values((ChannelStore as any).getMutablePrivateChannels?.() ?? {});
    const dms = priv
        .filter(c => c && (c.type === 1 || c.type === 3))
        .slice(0, 200)
        .map(c => {
            const users = (c.recipients ?? []).map((id: string) => UserStore.getUser(id)).filter(Boolean);
            const first: any = users[0];
            const name = c.type === 3 ? (c.name || users.map((u: any) => u.globalName || u.username).join(", ")) : (first ? first.globalName || first.username : "Direct message");
            const avatar = c.type === 1 && first?.avatar ? `https://cdn.discordapp.com/avatars/${first.id}/${first.avatar}.png?size=64` : undefined;
            return { id: String(c.id), name: String(name), group: c.type === 3, avatar };
        });
    send({
        t: "hello",
        version: VERSION,
        dms,
        user: { id: String(me.id), username: String(me.username), globalName: me.globalName ?? undefined, avatar: me.avatar ?? undefined },
        guilds,
    });
}

const helloSoon = () => {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(hello, 1500);
};

/** the option tree of a slash command, trimmed to what opentrench needs to read arguments */
function trimOptions(options: any): any[] | undefined {
    if (!Array.isArray(options) || options.length === 0) return undefined;
    return options.slice(0, 25).map((o: any) => ({
        type: Number(o.type),
        name: String(o.name),
        description: o.description ? String(o.description) : undefined,
        required: !!o.required,
        choices: Array.isArray(o.choices) ? o.choices.slice(0, 25).map((c: any) => ({ name: String(c.name), value: c.value })) : undefined,
        options: trimOptions(o.options),
    }));
}

/** a server's (or the DMs') command index, kept five minutes: what the client's "/" menu is built from */
const indexCache = new Map<string, { at: number; apps: Map<string, any>; commands: any[]; }>();

/**
 * The slash commands usable in a channel, from the same command index the client's own "/" menu
 * reads (the older search endpoint answers empty these days). `query` narrows by name prefix.
 */
async function searchCommands(channelId: string, query: string): Promise<{ apps: Map<string, any>; commands: any[]; }> {
    const ch: any = ChannelStore.getChannel(channelId);
    const key = ch?.guild_id ? `guild:${ch.guild_id}` : "dm";
    let hit = indexCache.get(key);
    if (!hit || Date.now() - hit.at > 5 * 60_000) {
        const url = ch?.guild_id ? `/guilds/${ch.guild_id}/application-command-index` : "/users/@me/application-command-index";
        const res: any = await RestAPI.get({ url, retries: 1 });
        const body = res?.body ?? {};
        const apps = new Map<string, any>();
        for (const a of body.applications ?? []) apps.set(String(a.id), a);
        const commands: any[] = (body.application_commands ?? []).filter((c: any) => c && (c.type ?? 1) === 1);
        for (const c of commands) commandCache.set(String(c.id), c);
        if (commandCache.size > 5000) commandCache.clear();
        if (indexCache.size > 50) indexCache.clear();
        hit = { at: Date.now(), apps, commands };
        indexCache.set(key, hit);
    }
    const q = query.toLowerCase();
    const commands = (q ? hit.commands.filter(c => String(c.name).toLowerCase().startsWith(q)) : hit.commands).slice(0, 400);
    return { apps: hit.apps, commands };
}

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
        } else if (op === "commands") {
            const channelId = String(req.channelId);
            const { apps, commands } = await searchCommands(channelId, String(req.query ?? "").trim());
            result = commands.map(c => {
                const app = apps.get(String(c.application_id));
                return {
                    id: String(c.id),
                    applicationId: String(c.application_id),
                    version: String(c.version),
                    name: String(c.name),
                    description: String(c.description ?? ""),
                    options: trimOptions(c.options),
                    app: app?.name ? String(app.name) : undefined,
                    icon: app?.icon ? `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png?size=64` : undefined,
                };
            });
        } else if (op === "command") {
            // run a slash command: the interaction the client's own composer would send
            const channelId = String(req.channelId);
            const ch: any = ChannelStore.getChannel(channelId);
            let cmd = commandCache.get(String(req.commandId));
            if (!cmd) cmd = (await searchCommands(channelId, String(req.name ?? ""))).commands.find(c => String(c.id) === String(req.commandId));
            if (!cmd) throw new Error("that command is not available here any more");
            const sessionId = SessionInfo?.getSessionId?.();
            if (!sessionId) throw new Error("no gateway session yet; is Discord connected?");
            await RestAPI.post({
                url: "/interactions",
                body: {
                    type: 2,
                    application_id: String(cmd.application_id),
                    guild_id: ch?.guild_id ? String(ch.guild_id) : undefined,
                    channel_id: channelId,
                    session_id: String(sessionId),
                    data: {
                        version: String(cmd.version),
                        id: String(cmd.id),
                        name: String(cmd.name),
                        type: 1,
                        options: Array.isArray(req.options) ? req.options : [],
                        application_command: cmd,
                        attachments: [],
                    },
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    analytics_location: "slash_ui",
                },
            });
            result = true;
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
