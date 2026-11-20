import { useCallback, useRef } from "react";
import { SKIN_LINE } from "@contracts/grade";
import { SCOPE_H, SCOPE_W } from "./NlePlayer";

// The scopes under the editor's viewer: the waveform and the vectorscope of the picture on screen, made on the graphics
// card by the player (lib/nle/gl-stage.ts) from each new picture, with GradePanel's lines (0–100 on a 0–110 scale, the
// vectorscope's 75% circle and skin tone line).

const TOP = 1.1;

function lines(ctx: CanvasRenderingContext2D, vector: boolean) {
  const [W, H] = [SCOPE_W, SCOPE_H];
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "9px ui-monospace, monospace";
  ctx.lineWidth = 1;
  if (vector) {
    const S = (H / 2 - 4) / 0.45;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, S * 0.45, 0, Math.PI * 2);
    ctx.moveTo(W / 2 - 4, H / 2);
    ctx.lineTo(W / 2 + 4, H / 2);
    ctx.moveTo(W / 2, H / 2 - 4);
    ctx.lineTo(W / 2, H / 2 + 4);
    ctx.stroke();
    const a = (SKIN_LINE * Math.PI) / 180;
    ctx.strokeStyle = "rgba(251,191,36,0.5)";
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 + Math.cos(a) * S * 0.45, H / 2 - Math.sin(a) * S * 0.45);
    ctx.stroke();
    return;
  }
  for (const v of [0, 25, 50, 75, 100]) {
    const y = Math.round(H - 3 - (v / 100 / TOP) * (H - 6)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(String(v), 2, y - 2);
  }
}

/** The scopes strip and the player's `onScopes` that draws on it. */
export function useNleScopes() {
  const wave = useRef<HTMLCanvasElement>(null);
  const vector = useRef<HTMLCanvasElement>(null);
  const none = useRef<HTMLDivElement>(null);
  const onScopes = useCallback((w: ImageData | null, v: ImageData | null) => {
    if (none.current) none.current.hidden = !!(w && v);
    for (const [cv, img, isVector] of [[wave.current, w, false], [vector.current, v, true]] as const) {
      const ctx = cv?.getContext("2d");
      if (!ctx) continue;
      if (img) ctx.putImageData(img, 0, 0);
      else ctx.clearRect(0, 0, SCOPE_W, SCOPE_H);
      lines(ctx, isVector);
    }
  }, []);
  const strip = (
    <div className="relative flex shrink-0 justify-center gap-2 border-t border-black/60 bg-[#1a1a1d] p-1.5">
      <canvas ref={wave} width={SCOPE_W} height={SCOPE_H} aria-label="Waveform" className="h-28 min-w-0 rounded bg-black" />
      <canvas ref={vector} width={SCOPE_W} height={SCOPE_H} aria-label="Vectorscope" className="h-28 min-w-0 rounded bg-black" />
      <div ref={none} hidden className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-500">Scopes are not available here</div>
    </div>
  );
  return { onScopes, strip };
}
