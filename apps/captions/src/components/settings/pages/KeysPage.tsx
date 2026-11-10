import { useMe } from "@/lib/auth";
import { MyKeysSection } from "../MyKeysSection";
import { ServiceKeysSection } from "../ServiceKeysSection";

/**
 * Settings → API keys. Temporary: the person's own keys, and for an admin the server's keys (the connections builder moves
 * the server's keys to Admin and rebuilds this page). The old readiness list is dropped from this page.
 */
export function KeysPage() {
  const me = useMe();
  return (
    <>
      <MyKeysSection />
      {me?.role === "admin" && <ServiceKeysSection />}
    </>
  );
}
