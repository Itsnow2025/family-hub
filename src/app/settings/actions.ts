"use server";

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/session";

export async function switchConnectedAi(formData: FormData): Promise<void> {
  const { supabase } = await requireMember("/settings");
  const enabled = formData.get("enabled") === "on";
  // The database decides who may flip which switch; a refused change is ignored.
  await supabase.from("connected_ais").update({ enabled }).eq("id", String(formData.get("id")));
  revalidatePath("/settings");
}

export async function switchAiAccess(formData: FormData): Promise<void> {
  const { supabase } = await requireMember("/settings");
  const on = formData.get("ai_access") === "on";
  await supabase.from("members").update({ ai_access: on }).eq("id", String(formData.get("member_id")));
  revalidatePath("/settings");
}
