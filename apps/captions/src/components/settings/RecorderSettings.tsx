import { Switch } from "@/components/ui/switch";
import { Card, Row, SettingsSelect } from "./ui";
import { tell, useThisMac } from "./ThisMacSection";

/** The screen's longest side and the camera's height, in pixels, as the Mac app takes them (RecordTypes.swift RecordPrefs). */
const SCREEN = [
  { value: "3840", label: "Up to 4K" },
  { value: "2560", label: "Up to 1440p" },
  { value: "1920", label: "Up to 1080p" },
];
const CAMERA = [
  { value: "720", label: "720p" },
  { value: "1080", label: "1080p" },
  { value: "2160", label: "4K, if the camera has it" },
];

/**
 * Settings → Tools → Screen Recorder, in the Mac app: how sharp the screen and the camera are recorded, and whether
 * Save and Send hand over the streams as separate files too. The app keeps every value; a change goes to it as
 * `recorder:<what>:<value>` and comes back in its next answer. A Mac app without these says nothing here.
 */
export function RecorderSettings() {
  const r = useThisMac(true)?.recorder;
  if (!r) return null;
  const set = (what: string, value: string) => tell(`recorder:${what}:${value}`);
  return (
    <Card>
      <Row
        id="recorder-streams"
        title="Save the streams separately"
        description="Save also writes the camera, your voice and the Mac's sound as their own files beside the video, and Send uploads the camera as its own video, so an AI or another editor can work with each one."
        control={<Switch checked={r.keep} aria-label="Save the streams separately" onCheckedChange={(on) => set("keep", on ? "1" : "0")} />}
      />
      <Row
        id="recorder-screen-quality"
        title="Screen quality"
        description="At 60 frames a second. Smaller makes smaller files."
        control={<SettingsSelect label="Screen quality" value={String(r.screen)} onValueChange={(v) => set("screen", v)} options={SCREEN} />}
      />
      <Row
        id="recorder-camera-quality"
        title="Camera quality"
        description="At 30 frames a second, from the next time the camera opens."
        control={<SettingsSelect label="Camera quality" value={String(r.camera)} onValueChange={(v) => set("camera", v)} options={CAMERA} />}
      />
    </Card>
  );
}
