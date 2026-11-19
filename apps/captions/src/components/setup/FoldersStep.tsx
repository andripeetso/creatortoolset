import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";

/**
 * "Where are your videos?" in the path: the folders are set up in the Media Library's setup sheet (one entry point),
 * which this step opens. Nothing is created here.
 */
export function FoldersStep({ onNext, actions }: { onNext: () => void; actions: HTMLElement | null }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={() => navigate("/library?setup=1")}>
        Set up the Media Library
      </Button>
      {actions && createPortal(<Button onClick={onNext}>Continue</Button>, actions)}
    </div>
  );
}
