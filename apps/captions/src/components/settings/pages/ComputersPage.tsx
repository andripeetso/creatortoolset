import { DevicesSection } from "../DevicesSection";
import { ThisMacSection, hasThisMac } from "../ThisMacSection";

/**
 * Settings → Computers, Folders and Servers (all three draw this until the computers builder splits them). This Mac's
 * section shows only in the Mac app (ThisMacSection.tsx); a browser never shows it.
 */
export function ComputersPage() {
  return (
    <>
      {hasThisMac() && <ThisMacSection />}
      <DevicesSection />
    </>
  );
}
