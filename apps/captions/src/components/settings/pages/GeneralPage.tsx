import { GeneralSection } from "../GeneralSection";
import { SetupSection } from "../SetupSection";
import { StorageSection } from "../StorageSection";

/**
 * Settings → General. Temporary: draws the three old bodies it used to show (General, Setup, Cache). The personal builder
 * replaces this file's contents with the new General page.
 */
export function GeneralPage() {
  return (
    <>
      <GeneralSection />
      <SetupSection />
      <StorageSection />
    </>
  );
}
