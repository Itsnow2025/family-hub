import { redirect } from "next/navigation";
import { requireMember } from "@/lib/session";

export default async function Home() {
  const { me } = await requireMember("/");
  redirect(`/file/${me.name.toLowerCase()}`);
}
