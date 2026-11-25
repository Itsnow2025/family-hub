import type {
  ConnectionStatus,
  Entry,
  Goal,
  HubData,
  HubList,
  ItemStatus,
  ListItem,
  Member,
  NewPreference,
  PersonalFile,
  Preference,
  PreferenceStatus,
  Review,
} from "@/lib/hub/types";
import { canWriteFile } from "@/lib/hub/types";

export const PHIL: Member = { id: "11111111-1111-4111-8111-111111111111", name: "Phil", role: "parent" };
export const FERIQUE: Member = { id: "22222222-2222-4222-8222-222222222222", name: "Ferique", role: "parent" };
export const GIGI: Member = { id: "33333333-3333-4333-8333-333333333333", name: "Gigi", role: "child" };
export const FAMILY = [PHIL, FERIQUE, GIGI];

// One shared in-memory family database. Each person gets a view of it that
// applies the same reading and writing rules as the real database.
export class FakeFamily {
  preferences: Preference[] = [];
  about = new Map<string, string | null>();
  log: { actor: string; action: string; subjectId?: string }[] = [];
  aiStatus = new Map<string, ConnectionStatus["status"]>();
  lists: Omit<HubList, "needed">[] = [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-999999999999", name: "Shopping", visibility: "family", ownerId: FERIQUE.id },
  ];
  items: ListItem[] = [];
  goals: Omit<Goal, "lead" | "team">[] = [];
  entries: (Omit<Entry, "who" | "thanksTo" | "addedBy"> & { thanksToId: string | null; addedById: string; withdrawn: boolean })[] = [];
  reviews: (Omit<Review, "who"> & { superseded: boolean })[] = [];
  seq = 0;

  nextId(prefix: string): string {
    return `${prefix}-${prefix}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${String(++this.seq).padStart(12, "0")}`;
  }

  viewFor(me: Member): HubData {
    return viewOf(this, me);
  }
}

function viewOf(family: FakeFamily, me: Member): HubData {
    const visible = (p: Preference) => {
      const owner = FAMILY.find((m) => m.id === p.memberId)!;
      if (canWriteFile(me, owner)) return true;
      if (p.status !== "confirmed") return false;
      return p.visibility === "family" || (p.visibility === "parents" && me.role === "parent");
    };
    return {
      async status() {
        const s = family.aiStatus.get(me.id) ?? "ok";
        if (s === "ok") return { status: "ok", member: me, door: "grok", clientName: "Grok" };
        if (s === "switched_off") return { status: "switched_off", member: me, clientName: "Grok" };
        if (s === "not_a_member") return { status: "not_a_member" };
        return { status: s, member: me } as ConnectionStatus;
      },
      async members() {
        return FAMILY;
      },
      async readFile(memberId, options): Promise<PersonalFile | null> {
        const member = FAMILY.find((m) => m.id === memberId);
        if (!member) return null;
        return {
          member,
          about: family.about.get(memberId) ?? null,
          preferences: family.preferences.filter(
            (p) => p.memberId === memberId && visible(p) && (options?.includeRetired || p.status !== "retired"),
          ),
        };
      },
      async addPreference(input: NewPreference): Promise<Preference> {
        const owner = FAMILY.find((m) => m.id === input.memberId)!;
        if (!canWriteFile(me, owner) || input.addedBy !== me.id) throw new Error("row level security refused");
        if (owner.role === "child" && input.visibility === "private") throw new Error("child files have no private entries");
        const p: Preference = {
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++family.seq).padStart(12, "0")}`,
          memberId: input.memberId,
          category: input.category,
          statement: input.statement,
          detail: input.detail ?? null,
          visibility: input.visibility,
          status: input.status,
          source: input.source,
          door: "grok",
          addedBy: me.name,
          createdAt: new Date(0).toISOString(),
        };
        family.preferences.push(p);
        return p;
      },
      async setPreferenceStatus(id: string, status: PreferenceStatus) {
        const p = family.preferences.find((x) => x.id === id);
        if (!p) return null;
        const owner = FAMILY.find((m) => m.id === p.memberId)!;
        if (!canWriteFile(me, owner)) return null;
        p.status = status;
        return p;
      },
      async updateAbout(memberId, about) {
        const owner = FAMILY.find((m) => m.id === memberId);
        if (!owner || !canWriteFile(me, owner)) return false;
        family.about.set(memberId, about);
        return true;
      },
      async log(entry) {
        family.log.push({ actor: me.name, action: entry.action, subjectId: entry.subjectId });
      },

      async lists() {
        return family.lists.filter(canSeeList).map((l) => ({
          ...l,
          needed: family.items.filter((i) => i.listId === l.id && i.status === "needed").length,
        }));
      },
      async listItems(listId, options) {
        const list = family.lists.find((l) => l.id === listId);
        if (!list || !canSeeList(list)) return [];
        return family.items.filter(
          (i) => i.listId === listId && (i.status === "needed" || (options?.includeGot && i.status === "got")),
        );
      },
      async createList(input) {
        if (input.ownerId !== me.id) throw new Error("row level security refused");
        const list = { id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++family.seq).padStart(12, "0")}`, ...input };
        family.lists.push(list);
        return { ...list, needed: 0 };
      },
      async addListItems(listId, addedBy, items) {
        const list = family.lists.find((l) => l.id === listId);
        if (!list || !canSeeList(list) || addedBy !== me.id) throw new Error("row level security refused");
        const added = items.map((item): ListItem => ({
          id: `cccccccc-cccc-4ccc-8ccc-${String(++family.seq).padStart(12, "0")}`,
          listId,
          item,
          note: null,
          status: "needed",
          addedBy: me.name,
          door: "grok",
          addedAt: new Date(0).toISOString(),
          doneBy: null,
          doneAt: null,
        }));
        family.items.push(...added);
        return added;
      },
      async setListItemStatus(ids: string[], status: ItemStatus) {
        const changed = family.items.filter((i) => {
          const list = family.lists.find((l) => l.id === i.listId);
          return ids.includes(i.id) && list && canSeeList(list);
        });
        for (const item of changed) {
          item.status = status;
          item.doneBy = status === "needed" ? null : me.name;
        }
        return changed;
      },

      async goals(options) {
        return family.goals
          .filter((g) => canSeeGoal(g) && (options?.includeClosed || g.status === "active" || g.status === "paused"))
          .map(goalOut);
      },
      async addGoal(input) {
        const lead = FAMILY.find((m) => m.id === input.leadId)!;
        if (input.createdBy !== me.id || !canWriteFile(me, lead)) throw new Error("row level security refused");
        const goal = {
          id: family.nextId("dddddddd"),
          title: input.title,
          why: input.why ?? null,
          kind: input.kind ?? "goal",
          parentId: input.parentId ?? null,
          measure: input.measure ?? null,
          targetDate: input.targetDate ?? null,
          status: "active" as const,
          visibility: input.visibility ?? "family",
          leadId: input.leadId,
          teamIds: (input.teamIds ?? []).filter((id) => id !== input.leadId),
        };
        family.goals.push(goal);
        return goalOut(goal);
      },
      async updateGoal(id, patch) {
        const goal = family.goals.find((g) => g.id === id);
        if (!goal || !canEditGoal(goal)) return null;
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) (goal as Record<string, unknown>)[k] = v;
        return goalOut(goal);
      },
      async addGoalPeople(goalId, memberIds) {
        const goal = family.goals.find((g) => g.id === goalId);
        if (!goal || !canEditGoal(goal)) throw new Error("row level security refused");
        for (const id of memberIds) if (id !== goal.leadId && !goal.teamIds.includes(id)) goal.teamIds.push(id);
      },
      async entries(range) {
        return family.entries
          .filter((e) => !e.withdrawn && e.happenedOn >= range.from && e.happenedOn <= range.to && canSeeOwned(e.memberId, e.visibility))
          .map((e) => ({ ...e, who: nameOf(e.memberId)!, thanksTo: nameOf(e.thanksToId), addedBy: nameOf(e.addedById) }));
      },
      async addEntry(input) {
        const owner = FAMILY.find((m) => m.id === input.memberId)!;
        if (input.addedBy !== me.id || !canWriteFile(me, owner)) throw new Error("row level security refused");
        const visibility = input.visibility ?? (input.kind === "health" ? "parents" : "family");
        if (visibility === "private" && owner.role === "child") throw new Error("child journals have no private entries");
        const entry = {
          id: family.nextId("eeeeeeee"),
          memberId: input.memberId,
          kind: input.kind,
          body: input.body,
          goalId: input.goalId ?? null,
          thanksToId: input.thanksToId ?? null,
          tool: input.tool ?? null,
          happenedOn: input.happenedOn ?? "2026-11-24",
          visibility,
          door: "grok" as const,
          addedById: me.id,
          createdAt: new Date(0).toISOString(),
          withdrawn: false,
        };
        family.entries.push(entry);
        return { ...entry, who: owner.name, thanksTo: nameOf(entry.thanksToId), addedBy: me.name };
      },
      async withdrawEntry(id) {
        const entry = family.entries.find((e) => e.id === id);
        if (!entry || !canWriteFile(me, FAMILY.find((m) => m.id === entry.memberId)!)) return false;
        entry.withdrawn = true;
        return true;
      },
      async reviews(weekStart) {
        return family.reviews
          .filter((r) => !r.superseded && r.weekStart === weekStart && canSeeOwned(r.memberId, "family"))
          .map((r) => ({ ...r, who: nameOf(r.memberId)! }));
      },
      async saveReview(input) {
        const owner = FAMILY.find((m) => m.id === input.memberId)!;
        if (input.addedBy !== me.id || !canWriteFile(me, owner)) throw new Error("row level security refused");
        for (const r of family.reviews) if (r.memberId === input.memberId && r.weekStart === input.weekStart) r.superseded = true;
        const review = {
          id: family.nextId("ffffffff"),
          weekStart: input.weekStart,
          memberId: input.memberId,
          body: input.body,
          aiSkill: input.aiSkill ?? null,
          nextTry: input.nextTry ?? null,
          door: "grok" as const,
          createdAt: new Date(0).toISOString(),
          superseded: false,
        };
        family.reviews.push(review);
        return { ...review, who: owner.name };
      },
    };

  function nameOf(id: string | null): string | null {
    return id ? (FAMILY.find((m) => m.id === id)?.name ?? null) : null;
  }

  function canSeeGoal(g: Omit<Goal, "lead" | "team">): boolean {
    const lead = FAMILY.find((m) => m.id === g.leadId)!;
    return (
      g.leadId === me.id ||
      g.visibility === "family" ||
      (g.visibility === "parents" && me.role === "parent") ||
      (me.role === "parent" && lead.role === "child") ||
      g.teamIds.includes(me.id)
    );
  }

  function canEditGoal(g: Omit<Goal, "lead" | "team">): boolean {
    const lead = FAMILY.find((m) => m.id === g.leadId)!;
    return g.leadId === me.id || (me.role === "parent" && lead.role === "child") || g.teamIds.includes(me.id);
  }

  function goalOut(g: Omit<Goal, "lead" | "team">): Goal {
    return { ...g, lead: nameOf(g.leadId)!, team: g.teamIds.map((id) => nameOf(id)!) };
  }

  function canSeeOwned(ownerId: string, visibility: string): boolean {
    const owner = FAMILY.find((m) => m.id === ownerId)!;
    return (
      ownerId === me.id ||
      (me.role === "parent" && owner.role === "child") ||
      visibility === "family" ||
      (visibility === "parents" && me.role === "parent")
    );
  }

  function canSeeList(list: Omit<HubList, "needed">): boolean {
    const owner = FAMILY.find((m) => m.id === list.ownerId)!;
    return (
      list.ownerId === me.id ||
      list.visibility === "family" ||
      (list.visibility === "parents" && me.role === "parent") ||
      (me.role === "parent" && owner.role === "child")
    );
  }
}
