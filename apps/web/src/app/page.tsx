import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const DEMO_HANDLE = "ah-hock-chicken-rice";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <div className="mb-2">
        <h1 className="text-3xl font-bold tracking-tight">Gantry</h1>
        <p className="text-muted-foreground">
          One rail, two doors — QR for humans, x402 for AI agents.
        </p>
      </div>
      {[
        {
          href: "/onboard",
          title: "Onboard a merchant",
          desc: "Register on-chain and walk out with a printable QR",
        },
        {
          href: `/pay/${DEMO_HANDLE}`,
          title: "Payer page",
          desc: "Scan-to-pay flow (what the printed QR opens)",
        },
        {
          href: "/dashboard",
          title: "Merchant dashboard",
          desc: "Live settlement feed — the demo protagonist",
        },
        {
          href: `/qr/${DEMO_HANDLE}`,
          title: "Printable QR",
          desc: "Static standee for Ah Hock Chicken Rice",
        },
      ].map((item) => (
        <Link key={item.href} href={item.href}>
          <Card className="transition-colors hover:bg-accent">
            <CardHeader>
              <CardTitle>{item.title}</CardTitle>
              <CardDescription>{item.desc}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Settling on Base Sepolia · XSGD payouts · 0.5% protocol fee
        </CardContent>
      </Card>
    </main>
  );
}
