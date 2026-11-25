import { redirect } from "next/navigation";
import { requireMember } from "@/lib/session";

export default async function Home() {
  await requireMember("/");
  redirect("/brain");
}
