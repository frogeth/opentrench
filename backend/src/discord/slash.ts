/**
 * Discord slash commands typed as text. The client's own composer is a form; ours is a text box,
 * so `/cmd a b c` is mapped onto the command's declared options in order, the way a shell reads
 * positional arguments. Subcommands come first (`/settings show`), quotes group words, and the
 * last string option takes whatever is left.
 */

export interface SlashOption {
  /** 1 subcommand, 2 group, 3 string, 4 integer, 5 boolean, 6 user, 7 channel, 8 role, 9 mentionable, 10 number, 11 attachment */
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  options?: SlashOption[];
}
export interface SlashCommand {
  id: string;
  applicationId: string;
  version: string;
  name: string;
  description: string;
  options?: SlashOption[];
  /** the application's name, for the menu */
  app?: string;
  icon?: string;
}
/** what the interaction carries */
export interface InteractionOption {
  type: number;
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

/** Whitespace-separated words; "quoted phrases" stay together. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const SNOWFLAKE = /^\d{15,22}$/;
const MENTION = /^<[@#][!&]?(\d{15,22})>$/;

function coerce(opt: SlashOption, raw: string): string | number | boolean {
  if (opt.choices?.length) {
    const hit = opt.choices.find((c) => String(c.name).toLowerCase() === raw.toLowerCase() || String(c.value).toLowerCase() === raw.toLowerCase());
    if (!hit) throw new Error(`${opt.name} must be one of: ${opt.choices.map((c) => c.name).join(', ')}`);
    return hit.value;
  }
  switch (opt.type) {
    case 4: {
      if (!/^-?\d+$/.test(raw)) throw new Error(`${opt.name} must be a whole number`);
      return Number(raw);
    }
    case 10: {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${opt.name} must be a number`);
      return n;
    }
    case 5: {
      if (/^(true|yes|on|1)$/i.test(raw)) return true;
      if (/^(false|no|off|0)$/i.test(raw)) return false;
      throw new Error(`${opt.name} must be true or false`);
    }
    case 6:
    case 7:
    case 8:
    case 9: {
      const m = MENTION.exec(raw);
      if (m) return m[1];
      if (SNOWFLAKE.test(raw)) return raw;
      throw new Error(`${opt.name} needs a mention or an id`);
    }
    case 11:
      throw new Error(`${opt.name} is a file; attach it in Discord`);
    default:
      return raw;
  }
}

/**
 * Map the text after the command name onto its options. Returns the interaction's `options`.
 * Throws a readable error when a required option is missing or a value does not fit.
 */
export function buildOptions(options: SlashOption[] | undefined, argsText: string): InteractionOption[] {
  const defs = options ?? [];
  const words = splitArgs(argsText);
  const subs = defs.filter((o) => o.type === 1 || o.type === 2);
  if (subs.length) {
    const pick = words[0]?.toLowerCase();
    const sub = subs.find((s) => s.name.toLowerCase() === pick);
    if (!sub) throw new Error(`pick one: ${subs.map((s) => s.name).join(', ')}`);
    const rest = argsText.replace(/^\s*\S+\s*/, '');
    return [{ type: sub.type, name: sub.name, options: buildOptions(sub.options, rest) }];
  }
  const out: InteractionOption[] = [];
  // the last string option swallows the remainder, so `/say hello there` needs no quotes
  const lastString = [...defs].reverse().find((o) => o.type === 3);
  let i = 0;
  for (const opt of defs) {
    if (i >= words.length) {
      if (opt.required) throw new Error(`needs ${opt.name}${opt.description ? ` (${opt.description})` : ''}`);
      continue;
    }
    let raw: string;
    if (opt === lastString && !opt.choices?.length && defs.indexOf(opt) === defs.length - 1) {
      // everything that is left, as typed
      const taken = words.slice(0, i);
      let text = argsText.trimStart();
      for (const w of taken) text = text.replace(/^("[^"]*"|'[^']*'|\S+)\s*/, () => '').trimStart();
      raw = text.trim();
      i = words.length;
    } else raw = words[i++];
    out.push({ type: opt.type, name: opt.name, value: coerce(opt, raw) });
  }
  if (i < words.length) throw new Error(`too many values: what is "${words.slice(i).join(' ')}" for?`);
  return out;
}

/** `/name <required> [optional]`, for the menu and the hint under the box. */
export function signature(cmd: { name: string; options?: SlashOption[] }): string {
  const opts = cmd.options ?? [];
  if (opts.some((o) => o.type === 1 || o.type === 2)) return `/${cmd.name} ${opts.map((o) => o.name).join(' | ')}`;
  return `/${cmd.name}${opts.map((o) => (o.required ? ` <${o.name}>` : ` [${o.name}]`)).join('')}`;
}
