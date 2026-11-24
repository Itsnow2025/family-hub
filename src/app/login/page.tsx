import { Card, Page } from "@/components/ui";
import { safeReturnPath } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const connecting = safeReturnPath(next).startsWith("/oauth/consent");
  return (
    <Page>
      <div className="mx-auto mt-10 max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Family Hub</h1>
        <p className="mb-6 text-sm text-muted">
          {connecting ? "Sign in to connect your AI." : "Private to Phil, Ferique and Gigi."}
        </p>
        {error === "not_member" ? (
          <p className="mb-4 text-sm text-warn">That account is not a Family Hub member.</p>
        ) : null}
        <Card>
          <LoginForm next={safeReturnPath(next)} />
        </Card>
      </div>
    </Page>
  );
}
