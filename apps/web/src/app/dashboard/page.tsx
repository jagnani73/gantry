import { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard-client";

export default function DashboardPage() {
  // DashboardClient reads `?handle=` via useSearchParams, which Next 15 refuses
  // to prerender outside a Suspense boundary.
  return (
    <Suspense>
      <DashboardClient />
    </Suspense>
  );
}
