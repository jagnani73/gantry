import type { Metadata } from "next";
import { SettingsScreen } from "@/components/payer/screen-settings";

export const metadata: Metadata = { title: "Settings · Gantry" };

export default function SettingsPage() {
  return <SettingsScreen />;
}
