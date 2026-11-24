"use client";

import { useActionState } from "react";
import { Button, fieldClass } from "@/components/ui";
import { signIn, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="mb-1 block text-sm text-muted">Email</span>
        <input className={fieldClass} type="email" name="email" autoComplete="email" required />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm text-muted">Password</span>
        <input className={fieldClass} type="password" name="password" autoComplete="current-password" required />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-warn">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
