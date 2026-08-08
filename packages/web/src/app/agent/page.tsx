import Link from "next/link";
import { AgentClient } from "@/components/agent-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Gated on the same signal as `/onboard`: editing the policy is a relayer-signed
 * on-chain write, and unlike revoke — which can only ever DENY — an open editor
 * would let a visitor RAISE the agent's caps. The backend refuses it too
 * (POLICY_ADMIN_ENABLED), so this branch is about not showing a form that cannot
 * submit rather than about enforcement.
 */
const consoleEnabled = process.env.NODE_ENV !== "production";

export default function AgentPage() {
  if (consoleEnabled) return <AgentClient />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>The agent console runs on the owner&apos;s own device</CardTitle>
          <CardDescription>
            Editing a spend policy signs an on-chain transaction from the wallet&apos;s owner key, so
            it is not something a shared deployment can offer a visitor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            The policy itself is public: it lives in the wallet contract on Base Sepolia, and the
            merchant dashboard shows the live cap meter it enforces. What is gated here is the
            ability to change it.
          </p>
          <Button asChild>
            <Link href="/dashboard">See the live policy</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
