import { PayClient } from "@/components/pay-client";

export default async function PayPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <PayClient handle={handle} />;
}
