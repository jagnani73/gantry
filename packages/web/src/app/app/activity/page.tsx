import type { Metadata } from "next";
import { ActivityScreen } from "@/components/payer/screen-activity";

export const metadata: Metadata = { title: "Activity · Gantry" };

export default function ActivityPage() {
  return <ActivityScreen />;
}
