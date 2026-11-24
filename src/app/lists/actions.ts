"use server";

import { revalidatePath } from "next/cache";
import type { ItemStatus } from "@/lib/hub/types";
import { requireMember } from "@/lib/session";

// "milk, eggs" or one thing per line both work.
function splitItems(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 40);
}

export async function addItems(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/lists");
  const listId = String(formData.get("list_id") ?? "");
  const wanted = splitItems(String(formData.get("items") ?? ""));
  if (!listId || wanted.length === 0) return;
  const onList = new Set((await hub.listItems(listId)).map((i) => i.item.toLowerCase()));
  const fresh = wanted.filter((item) => {
    const key = item.toLowerCase();
    if (onList.has(key)) return false;
    onList.add(key);
    return true;
  });
  await hub.addListItems(listId, me.id, fresh);
  revalidatePath("/lists");
}

export async function setItemStatus(formData: FormData): Promise<void> {
  const { hub } = await requireMember("/lists");
  const status = String(formData.get("status")) as ItemStatus;
  if (!["needed", "got", "removed"].includes(status)) return;
  await hub.setListItemStatus([String(formData.get("id"))], status);
  revalidatePath("/lists");
}

export async function createList(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/lists");
  const name = String(formData.get("name") ?? "").trim().slice(0, 60);
  if (!name) return;
  const existing = await hub.lists();
  if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) return;
  await hub.createList({ name, visibility: "family", ownerId: me.id });
  revalidatePath("/lists");
}
