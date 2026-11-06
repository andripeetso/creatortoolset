import { useEffect, useState } from "react";

/** Phones and small windows — not iPad landscape / desktop. */
const QUERY =
  "(max-width: 767px), (max-width: 1023px) and (pointer: coarse)";

function matches(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(QUERY).matches;
}

export function usePhoneClipLayout(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return phone;
}
