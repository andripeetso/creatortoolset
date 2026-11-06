const AUTO_CADENCE_KEY = "cap-auto-cadence";

/** Default-on preference for automatically matching cadence after transcription. */
export function storedAutoCadence(): boolean {
  try {
    return localStorage.getItem(AUTO_CADENCE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function persistAutoCadence(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CADENCE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage can be unavailable in privacy mode; the project still keeps
    // the in-memory choice for this session.
  }
}
