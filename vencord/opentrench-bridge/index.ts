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
 *
 * The bridge itself is core.ts, shared with the BetterDiscord plugin; this file only finds
 * Discord's internals the Vencord way.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findLazy } from "@webpack";
import { AuthenticationStore, ChannelStore, FluxDispatcher, GuildChannelStore, GuildMemberStore, GuildRoleStore, GuildStore, RestAPI, SnowflakeUtils, UserStore } from "@webpack/common";

import { createBridge } from "./core";

const CloudUpload: any = findLazy(m => m.prototype?.trackUploadFinished);

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Port the opentrench backend listens on (the web page's port, 3210 by default)",
        default: 3210,
    },
});

const bridge = createBridge({
    client: "vencord",
    port: () => settings.store.port,
    // read at start(): the @webpack/common stores are live bindings filled in as Discord loads
    discord: () => ({
        ChannelStore,
        GuildChannelStore,
        GuildMemberStore,
        GuildRoleStore,
        GuildStore,
        UserStore,
        FluxDispatcher,
        RestAPI,
        SnowflakeUtils,
        AuthenticationStore,
        CloudUpload,
        sendMessage: (channelId, content, extra) => sendMessage(channelId, { content }, undefined, extra),
    }),
});

export default definePlugin({
    name: "OpentrenchBridge",
    description: "Feeds opentrench from this Discord client (no token, no self-bot) and lets it send through it.",
    authors: [Devs.Ven],
    settings,

    start() {
        bridge.start();
    },

    stop() {
        bridge.stop();
    },
});
