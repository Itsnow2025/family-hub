import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  begin,
  guarded,
  isResult,
  problem,
  READ_ONLY,
  text,
  WRITES,
  type DataForAuth,
  type ToolContext,
} from "./tools";
import type { HubData, HubList, ListItem, Member } from "./types";

export const DEFAULT_LIST = "Shopping";

const listField = z
  .string()
  .trim()
  .max(60)
  .optional()
  .describe('Which list, by name. Leave out for the family "Shopping" list.');

const itemsField = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(40)
  .describe("One entry per thing, in the person's own words, such as \"2 litres of milk\".");

function cleanListName(name: string): string {
  return name
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+list$/i, "")
    .replace(/\s+/g, " ");
}

// Finds a list by name: exact first, then a single loose match.
export function findList(lists: HubList[], name: string | undefined): HubList | undefined {
  const wanted = cleanListName(name ?? DEFAULT_LIST).toLowerCase();
  const exact = lists.find((l) => l.name.toLowerCase() === wanted);
  if (exact) return exact;
  const loose = lists.filter((l) => l.name.toLowerCase().includes(wanted) || wanted.includes(l.name.toLowerCase()));
  return loose.length === 1 ? loose[0] : undefined;
}

// Matches what someone said against the items on a list.
export function matchItems(items: ListItem[], said: string[]): { matched: ListItem[]; missing: string[] } {
  const matched: ListItem[] = [];
  const missing: string[] = [];
  for (const phrase of said) {
    const wanted = phrase.trim().toLowerCase();
    const free = items.filter((i) => !matched.includes(i));
    const exact = free.filter((i) => i.item.toLowerCase() === wanted);
    const loose = free.filter((i) => i.item.toLowerCase().includes(wanted) || wanted.includes(i.item.toLowerCase()));
    const hit = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
    if (hit) matched.push(hit);
    else missing.push(phrase);
  }
  return { matched, missing };
}

function names(items: { item: string }[] | string[]): string {
  return items.map((i) => (typeof i === "string" ? i : i.item)).join(", ");
}

function otherLists(lists: HubList[], current: HubList): string {
  const others = lists.filter((l) => l.id !== current.id);
  return others.length ? `\nOther lists: ${others.map((l) => `${l.name} (${l.needed})`).join(", ")}` : "";
}

function noSuchList(lists: HubList[], name: string | undefined): string {
  const have = lists.length ? `The lists are: ${lists.map((l) => l.name).join(", ")}.` : "There are no lists yet.";
  return `There is no list called "${name ?? DEFAULT_LIST}". ${have}`;
}

async function listFor(
  data: HubData,
  me: Member,
  name: string | undefined,
  createIfMissing: boolean,
): Promise<{ list: HubList; lists: HubList[]; created: boolean } | string> {
  const lists = await data.lists();
  const found = findList(lists, name);
  if (found) return { list: found, lists, created: false };
  if (!createIfMissing) return noSuchList(lists, name);
  const list = await data.createList({
    name: cleanListName(name ?? DEFAULT_LIST),
    visibility: "family",
    ownerId: me.id,
  });
  return { list, lists: [...lists, list], created: true };
}

export function registerListTools(server: McpServer, dataFor: DataForAuth): void {
  server.registerTool(
    "add_to_list",
    {
      title: "Add to a list",
      description:
        'Adds things to a shared family list. Without a list name it uses "Shopping". Naming a list that does not exist starts it. Send each thing as its own entry.',
      inputSchema: z.object({ items: itemsField, list: listField }),
      annotations: WRITES,
    },
    async ({ items, list }: { items: string[]; list?: string }, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const target = await listFor(data, me, list, true);
        if (typeof target === "string") return problem(target);

        const existing = await data.listItems(target.list.id);
        const onList = new Set(existing.map((i) => i.item.toLowerCase()));
        const fresh: string[] = [];
        const already: string[] = [];
        for (const item of items) {
          const key = item.toLowerCase();
          if (onList.has(key)) already.push(item);
          else {
            onList.add(key);
            fresh.push(item);
          }
        }
        const added = await data.addListItems(target.list.id, me.id, fresh);
        const lines: string[] = [];
        if (target.created) lines.push(`Started a new list called ${target.list.name}, visible to the whole family.`);
        if (added.length) lines.push(`Added to ${target.list.name}: ${names(added)}.`);
        if (already.length) lines.push(`Already on it: ${names(already)}.`);
        lines.push(`${target.list.name} now has ${onList.size} to get.`);
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "show_list",
    {
      title: "Show a list",
      description: 'Shows what is still to get on a shared list, and who added each thing. Without a list name it shows "Shopping".',
      inputSchema: z.object({
        list: listField,
        include_got: z.boolean().optional().describe("Also show what was ticked off in the last week."),
      }),
      annotations: READ_ONLY,
    },
    async ({ list, include_got }: { list?: string; include_got?: boolean }, ctx: ToolContext) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const target = await listFor(data, me, list, false);
        if (typeof target === "string") return problem(target);
        const items = await data.listItems(target.list.id, { includeGot: include_got ?? false });
        const needed = items.filter((i) => i.status === "needed");
        const got = items.filter((i) => i.status === "got");
        const lines = [
          needed.length ? `${target.list.name}, ${needed.length} to get:` : `${target.list.name} has nothing left to get.`,
          ...needed.map((i) => `- ${i.item}${i.addedBy ? ` (${i.addedBy})` : ""}`),
        ];
        if (got.length) lines.push("", "Got in the last week:", ...got.map((i) => `- ${i.item}`));
        return text(lines.join("\n") + otherLists(target.lists, target.list));
      }),
  );

  server.registerTool(
    "tick_off_list",
    {
      title: "Tick off a list",
      description:
        "Marks things on a shared list. got = bought or done; remove = no longer wanted; put_back = it was ticked off by mistake. Nothing is deleted.",
      inputSchema: z.object({
        items: itemsField,
        list: listField,
        action: z.enum(["got", "remove", "put_back"]).optional().describe("Defaults to got."),
      }),
      annotations: WRITES,
    },
    async (
      { items, list, action }: { items: string[]; list?: string; action?: "got" | "remove" | "put_back" },
      ctx: ToolContext,
    ) =>
      guarded(async () => {
        const caller = await begin(dataFor, ctx);
        if (isResult(caller)) return caller;
        const { data, me } = caller;
        const target = await listFor(data, me, list, false);
        if (typeof target === "string") return problem(target);
        const mode = action ?? "got";
        const all = await data.listItems(target.list.id, { includeGot: true });
        const pool = all.filter((i) => (mode === "put_back" ? i.status === "got" : i.status === "needed"));
        const { matched, missing } = matchItems(pool, items);
        const changed = await data.setListItemStatus(
          matched.map((i) => i.id),
          mode === "got" ? "got" : mode === "remove" ? "removed" : "needed",
        );
        const verb = mode === "got" ? "Ticked off" : mode === "remove" ? "Taken off" : "Put back on";
        const lines: string[] = [];
        if (changed.length) lines.push(`${verb} ${target.list.name}: ${names(changed)}.`);
        if (missing.length) lines.push(`Could not find on ${target.list.name}: ${names(missing)}.`);
        const left = pool.length - (mode === "put_back" ? 0 : changed.length);
        if (mode !== "put_back") lines.push(left > 0 ? `Still to get: ${left}.` : `${target.list.name} is all done.`);
        return changed.length ? text(lines.join("\n")) : problem(lines.join("\n"));
      }),
  );
}
