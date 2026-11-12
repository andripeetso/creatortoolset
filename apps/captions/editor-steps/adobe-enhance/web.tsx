import { useState } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, ErrorRow, LoadingRow, Row, Status } from "@/components/settings/ui";
import { useCachedLoad } from "@/lib/local-cache";
import { addEnhanceEngine } from "../../src/lib/enhance";
import { defineWebPlugin } from "../../src/lib/plugin";

// The page half: the engine's card on the Audio Enhancer, and the Settings section where the person signs in to Adobe.

interface AdobeState {
  chrome: boolean;
  signedIn: boolean;
  signingIn: boolean;
  off: string | null;
  error: string | null;
}

const STATE = "/api/x/adobe-enhance";
async function call(path = "", method = "GET"): Promise<AdobeState> {
  const r = await fetch(STATE + path, { method });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as AdobeState;
}

/** One row: where the sign-in stands, and the one thing to do about it. It follows the server by itself (no Check button). */
function AdobeSection() {
  const { data, error, refresh, set } = useCachedLoad<AdobeState>(STATE, () => call());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const act = (path: string) => {
    setBusy(true);
    setFailed("");
    call(path, "POST")
      .then(set, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!data)
    return <Card>{error ? <ErrorRow title="Couldn't load the Adobe sign-in" detail={error} retry={() => void refresh().catch(() => {})} /> : <LoadingRow />}</Card>;

  let status;
  let control = null;
  if (!data.chrome) status = <Status tone="attention">Needs Google Chrome on this Mac</Status>;
  else if (data.signingIn) {
    status = "Sign in to Adobe in the Chrome window. It closes once you are in.";
    control = (
      <Button size="sm" variant="outline" disabled>
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Waiting for you
      </Button>
    );
  } else if (data.signedIn) {
    status = data.off ? <Status tone="attention">{data.off}</Status> : <Status tone="ok">Signed in</Status>;
    control = (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => act("/signout")}>
        Sign out
      </Button>
    );
  } else {
    status = <Status tone="attention">Not signed in</Status>;
    control = (
      <Button size="sm" disabled={busy} onClick={() => act("/signin")}>
        Sign in to Adobe
      </Button>
    );
  }
  const problem = failed || (!data.signingIn && data.error);
  return (
    <Card>
      <Row
        title="Adobe account"
        description="For Adobe Enhance Speech in the Audio Enhancer."
        status={problem ? <Status tone="broken">{problem}</Status> : status}
        control={control}
      />
    </Card>
  );
}

addEnhanceEngine({
  key: "adobespeech",
  label: "Adobe",
  name: "Adobe Enhance Speech",
  hint: "Podcast-studio voice, with your own Adobe account",
  working: (s) =>
    s.status === "queued"
      ? "Waiting for the Adobe run before it."
      : "Usually a minute or two — you can already listen to the original below.",
});

export default defineWebPlugin({
  id: "adobe-enhance",
  name: "Adobe Enhance Speech",
  about: "Adobe's Enhance Speech in the Audio Enhancer, with your own Adobe account.",
  settings: [{ id: "adobe-enhance", title: "Adobe Enhance Speech", icon: AudioLines, adminOnly: true, tool: "enhance", body: <AdobeSection /> }],
});
