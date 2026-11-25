"use server";

import { revalidatePath } from "next/cache";
import { canLeadGoal, canWriteFile, type EntryKind, type GoalKind, type GoalStatus } from "@/lib/hub/types";
import { isDay, todayIn } from "@/lib/hub/week";
import { requireMember } from "@/lib/session";

const KINDS: EntryKind[] = ["win", "learning", "gratitude", "made", "health", "note"];
const GOAL_KINDS: GoalKind[] = ["dream", "goal", "milestone"];
const STATUSES: GoalStatus[] = ["active", "achieved", "paused", "let_go"];

function field(formData: FormData, name: string, max: number): string {
  return String(formData.get(name) ?? "").trim().slice(0, max);
}

export async function logEntry(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/brain");
  const members = await hub.members();
  const kind = field(formData, "kind", 20) as EntryKind;
  const body = field(formData, "body", 2000);
  if (!KINDS.includes(kind) || !body) return;
  const owner = members.find((m) => m.id === field(formData, "member_id", 64)) ?? me;
  if (!canWriteFile(me, owner)) return;
  const thanks = members.find((m) => m.id === field(formData, "thanks_to", 64));
  const goalId = field(formData, "goal_id", 64) || null;
  const day = field(formData, "happened_on", 10);
  await hub.addEntry({
    memberId: owner.id,
    addedBy: me.id,
    kind,
    body,
    goalId,
    thanksToId: thanks?.id ?? null,
    tool: field(formData, "tool", 60) || null,
    happenedOn: isDay(day) && day <= todayIn() ? day : undefined,
  });
  revalidatePath("/brain");
}

export async function withdrawEntry(formData: FormData): Promise<void> {
  const { hub } = await requireMember("/brain");
  await hub.withdrawEntry(field(formData, "id", 64));
  revalidatePath("/brain");
}

export async function addGoal(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/brain");
  const members = await hub.members();
  const title = field(formData, "title", 200);
  if (!title) return;
  const lead = members.find((m) => m.id === field(formData, "lead_id", 64)) ?? me;
  if (!canLeadGoal(me, lead)) return;
  const kind = field(formData, "kind", 20) as GoalKind;
  const target = field(formData, "target_date", 10);
  const team = formData
    .getAll("team")
    .map(String)
    .filter((id) => id !== lead.id && members.some((m) => m.id === id));
  await hub.addGoal({
    title,
    kind: GOAL_KINDS.includes(kind) ? kind : "goal",
    leadId: lead.id,
    createdBy: me.id,
    teamIds: team,
    why: field(formData, "why", 1000) || null,
    targetDate: isDay(target) ? target : null,
    parentId: field(formData, "parent_id", 64) || null,
  });
  revalidatePath("/brain");
}

export async function setGoalStatus(formData: FormData): Promise<void> {
  const { hub } = await requireMember("/brain");
  const status = field(formData, "status", 20) as GoalStatus;
  if (!STATUSES.includes(status)) return;
  await hub.updateGoal(field(formData, "id", 64), { status });
  revalidatePath("/brain");
}
