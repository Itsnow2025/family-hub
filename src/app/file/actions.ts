"use server";

import { revalidatePath } from "next/cache";
import { canWriteFile, type Visibility } from "@/lib/hub/types";
import { requireMember } from "@/lib/session";

const VISIBILITIES: Visibility[] = ["family", "parents", "private"];

function owner(members: { id: string; name: string; role: "parent" | "child" }[], id: string) {
  const found = members.find((m) => m.id === id);
  if (!found) throw new Error("No such family member.");
  return found;
}

export async function addPreference(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/");
  const file = owner(await hub.members(), String(formData.get("member_id")));
  if (!canWriteFile(me, file)) throw new Error("Not your file to write in.");
  const category = String(formData.get("category") ?? "").trim().toLowerCase().slice(0, 40);
  const statement = String(formData.get("statement") ?? "").trim().slice(0, 500);
  const detail = String(formData.get("detail") ?? "").trim().slice(0, 2000) || null;
  const chosen = String(formData.get("visibility") ?? "family") as Visibility;
  const visibility = VISIBILITIES.includes(chosen) ? chosen : "family";
  if (!category || !statement) return;
  await hub.addPreference({
    memberId: file.id,
    addedBy: me.id,
    category,
    statement,
    detail,
    visibility: file.role === "child" && visibility === "private" ? "parents" : visibility,
    status: "confirmed",
    source: file.id === me.id ? "self" : "parent",
  });
  revalidatePath(`/file/${file.name.toLowerCase()}`);
}

export async function changeStatus(formData: FormData): Promise<void> {
  const { hub } = await requireMember("/");
  const status = String(formData.get("status"));
  if (status !== "confirmed" && status !== "retired") return;
  await hub.setPreferenceStatus(String(formData.get("id")), status);
  revalidatePath("/file/[name]", "page");
}

export async function updateAbout(formData: FormData): Promise<void> {
  const { hub, me } = await requireMember("/");
  const file = owner(await hub.members(), String(formData.get("member_id")));
  if (!canWriteFile(me, file)) throw new Error("Not your file to write in.");
  const about = String(formData.get("about") ?? "").trim().slice(0, 1000);
  await hub.updateAbout(file.id, about || null);
  revalidatePath(`/file/${file.name.toLowerCase()}`);
}
