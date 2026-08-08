import type { Metadata } from "next";
import { WalletScreen } from "@/components/payer/screen-wallet";

export const metadata: Metadata = { title: "Wallet · Gantry" };

export default function WalletPage() {
  return <WalletScreen />;
}
