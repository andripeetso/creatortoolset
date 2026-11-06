import { useEffect, useState } from "react";

/** The latest Mac app the site serves (api/mac-app.ts, `/api/mac-app/download`), or null before the first release. */
export function useMacRelease() {
  const [release, setRelease] = useState<{ version: string } | null>(null);
  useEffect(() => {
    fetch("/api/mac-app")
      .then((r) => (r.ok ? r.json() : null))
      .then(setRelease)
      .catch(() => {});
  }, []);
  return release;
}
