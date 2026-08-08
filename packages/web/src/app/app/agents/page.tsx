import type { Metadata } from "next";
import { AgentsScreen } from "@/components/payer/screen-agents";

export const metadata: Metadata = { title: "Agents · Gantry" };

export default function AgentsPage() {
  return <AgentsScreen />;
}
