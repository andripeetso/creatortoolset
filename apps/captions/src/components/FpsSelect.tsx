import { useStudio } from "@/lib/store";

/**
 * Project frame-rate picker, shared by setup / settings / export. The
 * detected source rate (server probe or playback estimate) is labeled and
 * pre-selected; picking any value by hand pins it against later detection.
 */

const COMMON_FPS = [24, 25, 30, 50, 60];

export function FpsSelect({ className }: { className?: string }) {
  const fps = useStudio((s) => s.fps);
  const srcFps = useStudio((s) => s.srcFps);
  const setFps = useStudio((s) => s.setFps);

  const options = [...new Set([...COMMON_FPS, ...(srcFps ? [srcFps] : []), fps])].sort(
    (a, b) => a - b
  );

  return (
    <select
      value={fps}
      onChange={(e) => setFps(Number(e.target.value))}
      className={className}
    >
      {options.map((f) => (
        <option key={f} value={f}>
          {f}
          {f === srcFps ? " · source" : ""}
        </option>
      ))}
    </select>
  );
}
