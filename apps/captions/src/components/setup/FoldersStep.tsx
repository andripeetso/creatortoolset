import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { returnAfterLibrary, useSetup } from "@/lib/setup";
import { NeedLine } from "./ToolNeeds";

/**
 * "Where are your videos?": the folders are set up in the Media Library's setup sheet (one entry point), which this step
 * opens. On the path (`inPath`) setup opens on this screen again when that is done; alone it puts its Continue in
 * `actions`. Nothing is created here.
 */
export function FoldersStep({ onNext, actions, inPath }: { onNext: () => void; actions: HTMLElement | null; inPath: boolean }) {
  const navigate = useNavigate();
  const done = useSetup((s) => !!s.view?.have.includes("library"));
  const open = () => {
    if (inPath) returnAfterLibrary("folders");
    navigate("/library?setup=1");
  };
  return (
    <div className="space-y-4">
      {done ? (
        <ul>
          <NeedLine met name="Media Library" />
        </ul>
      ) : (
        <Button variant="outline" onClick={open}>
          Set up the Media Library
        </Button>
      )}
      {actions && !inPath && createPortal(<Button onClick={onNext}>Continue</Button>, actions)}
    </div>
  );
}
