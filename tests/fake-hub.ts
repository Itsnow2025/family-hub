import type {
  ConnectionStatus,
  HubData,
  Member,
  NewPreference,
  PersonalFile,
  Preference,
  PreferenceStatus,
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
  seq = 0;

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
    };
}
