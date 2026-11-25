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

export type ItemStatus = "needed" | "got" | "removed";

export interface HubList {
  id: string;
  name: string;
  visibility: Visibility;
  ownerId: string;
  needed: number;
}

export interface ListItem {
  id: string;
  listId: string;
  item: string;
  note: string | null;
  status: ItemStatus;
  addedBy: string | null;
  door: Door;
  addedAt: string;
  doneBy: string | null;
  doneAt: string | null;
}

export type GoalKind = "dream" | "goal" | "milestone";
export type GoalStatus = "active" | "achieved" | "paused" | "let_go";

export interface Goal {
  id: string;
  title: string;
  why: string | null;
  kind: GoalKind;
  parentId: string | null;
  measure: string | null;
  targetDate: string | null;
  status: GoalStatus;
  visibility: Visibility;
  leadId: string;
  lead: string;
  teamIds: string[];
  team: string[];
}

export interface NewGoal {
  title: string;
  leadId: string;
  createdBy: string;
  why?: string | null;
  kind?: GoalKind;
  parentId?: string | null;
  measure?: string | null;
  targetDate?: string | null;
  visibility?: Visibility;
  teamIds?: string[];
}

export type GoalPatch = Partial<
  Pick<Goal, "title" | "why" | "kind" | "parentId" | "measure" | "targetDate" | "status" | "visibility">
>;

// win = any win, however small. learning = what something taught us; there
// is no failure kind. made = something built or created.
export type EntryKind = "win" | "learning" | "gratitude" | "made" | "health" | "note";

export interface Entry {
  id: string;
  memberId: string;
  who: string;
  kind: EntryKind;
  body: string;
  goalId: string | null;
  thanksTo: string | null;
  tool: string | null;
  happenedOn: string;
  visibility: Visibility;
  door: Door;
  addedBy: string | null;
  createdAt: string;
}

export interface NewEntry {
  memberId: string;
  addedBy: string;
  kind: EntryKind;
  body: string;
  goalId?: string | null;
  thanksToId?: string | null;
  tool?: string | null;
  happenedOn?: string;
  visibility?: Visibility;
}

export interface Review {
  id: string;
  weekStart: string;
  memberId: string;
  who: string;
  body: string;
  aiSkill: string | null;
  nextTry: string | null;
  door: Door;
  createdAt: string;
}

export interface NewReview {
  weekStart: string;
  memberId: string;
  addedBy: string;
  body: string;
  aiSkill?: string | null;
  nextTry?: string | null;
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

  lists(): Promise<HubList[]>;
  listItems(listId: string, options?: { includeGot?: boolean }): Promise<ListItem[]>;
  createList(input: { name: string; visibility: Visibility; ownerId: string }): Promise<HubList>;
  addListItems(listId: string, addedBy: string, items: string[]): Promise<ListItem[]>;
  setListItemStatus(ids: string[], status: ItemStatus): Promise<ListItem[]>;

  goals(options?: { includeClosed?: boolean }): Promise<Goal[]>;
  addGoal(input: NewGoal): Promise<Goal>;
  updateGoal(id: string, patch: GoalPatch): Promise<Goal | null>;
  addGoalPeople(goalId: string, memberIds: string[]): Promise<void>;

  entries(range: { from: string; to: string }): Promise<Entry[]>;
  addEntry(input: NewEntry): Promise<Entry>;
  withdrawEntry(id: string): Promise<boolean>;

  reviews(weekStart: string): Promise<Review[]>;
  saveReview(input: NewReview): Promise<Review>;
}

// Who may lead a new goal set by this person. The database enforces the same rule.
export function canLeadGoal(actor: Member, lead: Member): boolean {
  return canWriteFile(actor, lead);
}

// Who may write in whose file. The database enforces the same rule.
export function canWriteFile(actor: Member, owner: Member): boolean {
  return actor.id === owner.id || (actor.role === "parent" && owner.role === "child");
}
