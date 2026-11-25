import Link from "next/link";
import type { ReactNode } from "react";
import type { Member } from "@/lib/hub/types";

export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6">{children}</main>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-4 sm:p-5 ${className}`}>{children}</section>
  );
}

export function Heading({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
    </div>
  );
}

export function Button({
  children,
  kind = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "quiet" | "warn" }) {
  const look =
    kind === "primary"
      ? "bg-accent text-accent-ink hover:opacity-90"
      : kind === "warn"
        ? "border border-line text-warn hover:bg-background"
        : "border border-line hover:bg-background";
  return (
    <button
      {...props}
      className={`inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-medium transition disabled:opacity-50 ${look} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export const fieldClass =
  "w-full rounded-lg border border-line bg-background px-3 py-2 text-base outline-none focus:border-accent";

export function Nav({ me, members, current }: { me: Member; members: Member[]; current?: string }) {
  const item = (href: string, label: string, key: string) => (
    <Link
      key={key}
      href={href}
      className={`rounded-lg px-3 py-1.5 text-sm ${current === key ? "bg-accent text-accent-ink" : "hover:bg-surface"}`}
    >
      {label}
    </Link>
  );
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-1 px-4 py-3">
        <Link href="/brain" className="mr-2 font-semibold tracking-tight">
          Family Brain
        </Link>
        {item("/brain", "This week", "brain")}
        {members.map((m) => item(`/file/${m.name.toLowerCase()}`, m.id === me.id ? `${m.name} (you)` : m.name, m.id))}
        {item("/lists", "Lists", "lists")}
        {item("/settings", "Settings", "settings")}
        <form action="/signout" method="post" className="ml-auto">
          <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface">Sign out</button>
        </form>
      </div>
    </header>
  );
}

export function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
