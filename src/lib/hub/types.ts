export type Role = "parent" | "child";
export type Visibility = "family" | "parents" | "private";
export type PreferenceStatus = "confirmed" | "suggested" | "retired";
export type PreferenceSource = "self" | "parent" | "ai_suggested" | "imported";
export type Door = "app" | "grok" | "claude" | "other_ai" | "system";

export interface Member {
  id: string;
  name: string;
  role: Role;
}

export type ConnectionStatus =
  | { status: "ok"; member: Member; door: Door; clientName: string }
  | { status: "app_session"; member: Member }
  | { status: "ai_access_off"; member: Member }
  | { status: "not_connected"; member: Member }
  | { status: "switched_off"; member: Member; clientName: string }
  | { status: "not_a_member" };

export interface Preference {
  id: string;
  memberId: string;
  category: string;
  statement: string;
  detail: string | null;
  visibility: Visibility;
  status: PreferenceStatus;
  source: PreferenceSource;
  door: Door;
  addedBy: string | null;
  createdAt: string;
}

export interface PersonalFile {
  member: Member;
  about: string | null;
  preferences: Preference[];
}

export interface NewPreference {
  memberId: string;
  addedBy: string;
  category: string;
  statement: string;
  detail?: string | null;
  visibility: Visibility;
  status: Extract<PreferenceStatus, "confirmed" | "suggested">;
  source: PreferenceSource;
}

// Everything the connector needs from the database. The real implementation
// runs every call as the signed-in person; the tests use an in-memory one.
export interface HubData {
  status(): Promise<ConnectionStatus>;
  members(): Promise<Member[]>;
  readFile(memberId: string, options?: { includeRetired?: boolean }): Promise<PersonalFile | null>;
  addPreference(input: NewPreference): Promise<Preference>;
  setPreferenceStatus(id: string, status: PreferenceStatus): Promise<Preference | null>;
  updateAbout(memberId: string, about: string | null): Promise<boolean>;
  log(entry: { action: string; subjectId?: string; targetId?: string; summary?: string }): Promise<void>;
}

// Who may write in whose file. The database enforces the same rule.
export function canWriteFile(actor: Member, owner: Member): boolean {
  return actor.id === owner.id || (actor.role === "parent" && owner.role === "child");
}
