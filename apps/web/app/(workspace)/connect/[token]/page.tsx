import { ConnectRequest } from "@/components/ConnectRequest";

export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ConnectRequest token={token} />;
}
