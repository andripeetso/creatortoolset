import { Smartphone } from "lucide-react";
import { ToolsetLogo } from "@/components/HomeLink";
import { APP_STORE_URL, appLink } from "@/lib/pairing";

/**
 * A pairing link opened in a browser (the iPhone Camera on an address the app can't claim, or a desktop): the code is
 * for the Creator Toolset app, so this page hands it over and never uses it.
 */
export function PairingLanding({ token }: { token: string }) {
  const host = window.location.host;
  const button = "rounded-lg bg-violet-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-violet-500";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 text-zinc-200">
      <div className="mb-6 flex items-center gap-3">
        <ToolsetLogo className="h-11 w-11" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Connect to {host}</h1>
          <p className="text-sm text-zinc-500">A link for the Creator Toolset app</p>
        </div>
      </div>
      <div className="flex w-72 flex-col gap-2">
        <a href={appLink(window.location.origin, token)} className={button}>
          Open in the app
        </a>
        <a href={APP_STORE_URL} className="rounded-lg border border-zinc-700 px-3 py-2 text-center text-sm hover:bg-zinc-900">
          Get the app on the App Store
        </a>
        <p className="mt-2 flex gap-2 text-xs text-zinc-500">
          <Smartphone className="h-4 w-4 shrink-0" />
          The code works once, in the app. On a computer, scan the QR code with your phone instead.
        </p>
      </div>
    </div>
  );
}
