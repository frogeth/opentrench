/*
 * opentrench bridge — the BetterDiscord plugin (https://github.com/frogeth/opentrench).
 *
 * The same bridge as the Vencord plugin (../vencord/opentrench-bridge/core.ts does the work);
 * this file only finds Discord's internals through BdApi and keeps the port setting.
 * Built into one OpentrenchBridge.plugin.js by build.mjs.
 */

import { createBridge, type DiscordInternals } from "../vencord/opentrench-bridge/core";

declare const BdApi: any;

const NAME = "OpentrenchBridge";
const DEFAULT_PORT = 3210;

const port = (): number => Number(BdApi.Data.load(NAME, "port")) || DEFAULT_PORT;

/** the first module, or any of its exports, the filter accepts (what Vencord's finders search too) */
function find(filter: (m: any) => boolean, what: string): any {
    const m = BdApi.Webpack.getModule((x: any) => {
        try {
            return !!x && filter(x);
        } catch {
            return false;
        }
    }, { searchExports: true });
    if (!m) throw new Error(`opentrench: Discord's ${what} was not found; the plugin needs an update`);
    return m;
}
const byKeys = (...keys: string[]) => find(m => typeof m === "object" && keys.every(k => k in m), keys.join("/"));
function store(name: string): any {
    const s = BdApi.Webpack.getStore(name);
    if (!s) throw new Error(`opentrench: Discord's ${name} was not found; the plugin needs an update`);
    return s;
}

function discord(): DiscordInternals {
    const MessageActions = byKeys("editMessage", "sendMessage");
    return {
        ChannelStore: store("ChannelStore"),
        GuildChannelStore: store("GuildChannelStore"),
        GuildMemberStore: store("GuildMemberStore"),
        GuildRoleStore: BdApi.Webpack.getStore("GuildRoleStore"),
        GuildStore: store("GuildStore"),
        UserStore: store("UserStore"),
        FluxDispatcher: byKeys("dispatch", "subscribe", "unsubscribe"),
        RestAPI: find(m => typeof m === "object" && m.del && m.put && m.get && m.post, "RestAPI"),
        SnowflakeUtils: byKeys("fromTimestamp", "extractTimestamp"),
        ReactionActions: byKeys("addReaction", "removeReaction"),
        SessionInfo: byKeys("getSessionId"),
        CloudUpload: find(m => typeof m === "function" && m.prototype?.trackUploadFinished, "upload class"),
        // what Vencord's sendMessage helper sends: the composer's own message shape
        sendMessage: (channelId, content, extra) =>
            MessageActions.sendMessage(channelId, { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] }, true, extra),
    };
}

export default class OpentrenchBridge {
    private bridge = createBridge({ discord, port });

    start() {
        this.bridge.start();
    }

    stop() {
        this.bridge.stop();
    }

    getSettingsPanel() {
        const wrap = document.createElement("div");
        wrap.style.cssText = "color: var(--text-normal); display: flex; flex-direction: column; gap: 8px;";
        const label = document.createElement("label");
        label.textContent = "Port the opentrench backend listens on (the web page's port, 3210 by default)";
        const input = document.createElement("input");
        input.type = "number";
        input.min = "1";
        input.max = "65535";
        input.value = String(port());
        input.style.cssText = "width: 120px; padding: 6px; border-radius: 4px; border: 1px solid var(--background-modifier-accent); background: var(--background-secondary); color: var(--text-normal);";
        input.addEventListener("change", () => {
            const n = Math.trunc(Number(input.value));
            if (!(n >= 1 && n <= 65535)) {
                input.value = String(port());
                return;
            }
            BdApi.Data.save(NAME, "port", n);
            this.bridge.reconnect();
        });
        wrap.append(label, input);
        return wrap;
    }
}
