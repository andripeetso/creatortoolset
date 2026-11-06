import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderPhase =
  | "idle"
  | "countdown"
  | "recording"
  | "paused"
  | "preview";

export interface RecorderPreview {
  blob: Blob;
  url: string;
  mime: string;
  duration: number;
}

function pickMime(): string {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function stopTracks(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * Browser screen recorder with optional webcam bubble and mixed mic.
 * Camera is composited onto a canvas so the saved file matches the preview.
 */
export function useClipsRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [count, setCount] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [mixStream, setMixStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<RecorderPreview | null>(null);

  const displayRef = useRef<MediaStream | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const hiddenVideosRef = useRef<HTMLVideoElement[]>([]);
  const rafRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const elapsedBaseRef = useRef(0);
  const mimeRef = useRef("");
  const abortRef = useRef(false);
  const phaseRef = useRef<RecorderPhase>("idle");
  phaseRef.current = phase;

  const nowElapsed = () => {
    const extra =
      phaseRef.current === "recording"
        ? (Date.now() - startedAtRef.current) / 1000
        : 0;
    return elapsedBaseRef.current + extra;
  };

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const cleanupLive = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    clearTimer();
    recRef.current = null;
    stopTracks(displayRef.current);
    stopTracks(cameraRef.current);
    stopTracks(micRef.current);
    displayRef.current = null;
    cameraRef.current = null;
    micRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    for (const v of hiddenVideosRef.current) {
      v.pause();
      v.srcObject = null;
    }
    hiddenVideosRef.current = [];
    setMixStream(null);
  }, []);

  useEffect(() => () => cleanupLive(), [cleanupLive]);

  const startClock = () => {
    startedAtRef.current = Date.now();
    clearTimer();
    timerRef.current = setInterval(() => setElapsed(nowElapsed()), 200);
  };

  const finishRecording = useCallback(
    (blob: Blob) => {
      const duration = nowElapsed();
      cleanupLive();
      const mime = blob.type || mimeRef.current || "video/webm";
      const url = URL.createObjectURL(blob);
      setElapsed(duration);
      setPreview({ blob, url, mime, duration });
      setPhase("preview");
    },
    [cleanupLive],
  );

  const attachRecorder = (stream: MediaStream, mime: string) => {
    mimeRef.current = mime;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 2_500_000,
    });
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onerror = () => setError("Recording failed");
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: mime || "video/webm",
      });
      finishRecording(blob);
    };
    recRef.current = rec;
    rec.start(1000);
    elapsedBaseRef.current = 0;
    setElapsed(0);
    startClock();
    setPhase("recording");
  };

  const composeStream = async (
    display: MediaStream,
    camera: MediaStream | null,
    mic: MediaStream | null,
  ): Promise<MediaStream> => {
    const mixAudio = async (video: MediaStream) => {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const dest = audioCtx.createMediaStreamDestination();
      const connect = (stream: MediaStream) => {
        if (!stream.getAudioTracks().length) return;
        audioCtx.createMediaStreamSource(stream).connect(dest);
      };
      connect(display);
      if (mic) connect(mic);
      const out = new MediaStream(video.getVideoTracks());
      for (const track of dest.stream.getAudioTracks()) out.addTrack(track);
      return out;
    };

    if (!camera) return mixAudio(display);

    const playHidden = async (stream: MediaStream) => {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.srcObject = stream;
      hiddenVideosRef.current.push(el);
      await el.play();
      if (!el.videoWidth) {
        await new Promise<void>((resolve) => {
          el.onloadedmetadata = () => resolve();
        });
      }
      return el;
    };

    const screenVideo = await playHidden(display);
    const camVideo = await playHidden(camera);

    const w = Math.min(screenVideo.videoWidth || 1280, 1920);
    const h = Math.min(screenVideo.videoHeight || 720, 1080);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create recorder canvas");

    const draw = () => {
      ctx.drawImage(screenVideo, 0, 0, w, h);
      if (camVideo && camVideo.videoWidth) {
        const size = Math.round(h * 0.22);
        const x = w - size - 24;
        const y = h - size - 24;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.translate(x + size, y);
        ctx.scale(-1, 1);
        ctx.drawImage(camVideo, 0, 0, size, size);
        ctx.restore();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(24);
    return mixAudio(canvasStream);
  };

  const beginCapture = async () => {
    const mime = pickMime();
    if (typeof MediaRecorder === "undefined") {
      throw new Error("This browser cannot record video");
    }
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 24, max: 30 },
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: micOn,
    } as DisplayMediaStreamOptions);
    displayRef.current = display;
    display.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (
        recRef.current?.state === "recording" ||
        recRef.current?.state === "paused"
      ) {
        recRef.current.stop();
      }
    });

    let camera: MediaStream | null = null;
    if (cameraOn) {
      try {
        camera = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 480 },
            height: { ideal: 480 },
            facingMode: "user",
          },
          audio: false,
        });
        cameraRef.current = camera;
      } catch {
        setCameraOn(false);
      }
    }

    let mic: MediaStream | null = null;
    if (micOn) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        micRef.current = mic;
      } catch {
        setMicOn(false);
      }
    }

    const mixed = await composeStream(display, camera, mic);
    setMixStream(mixed);
    attachRecorder(mixed, mime);
  };

  const start = async () => {
    setError(null);
    abortRef.current = false;
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setPhase("countdown");
    setCount(3);
    for (let n = 3; n >= 1; n--) {
      setCount(n);
      await new Promise((r) => setTimeout(r, 1000));
      if (abortRef.current) return;
    }
    try {
      await beginCapture();
    } catch (e) {
      cleanupLive();
      setPhase("idle");
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Screen sharing was cancelled"
          : e instanceof Error
            ? e.message
            : "Could not start recording",
      );
    }
  };

  const pause = () => {
    if (recRef.current?.state !== "recording") return;
    recRef.current.pause();
    elapsedBaseRef.current = nowElapsed();
    clearTimer();
    setElapsed(elapsedBaseRef.current);
    setPhase("paused");
  };

  const resume = () => {
    if (recRef.current?.state !== "paused") return;
    recRef.current.resume();
    startClock();
    setPhase("recording");
  };

  const stop = () => {
    if (!recRef.current || recRef.current.state === "inactive") return;
    recRef.current.stop();
  };

  const discard = () => {
    abortRef.current = true;
    if (recRef.current && recRef.current.state !== "inactive") {
      recRef.current.onstop = null;
      recRef.current.stop();
    }
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
    cleanupLive();
    setElapsed(0);
    setPhase("idle");
  };

  return {
    phase,
    cameraOn,
    micOn,
    setCameraOn,
    setMicOn,
    elapsed,
    count,
    error,
    mixStream,
    preview,
    start,
    pause,
    resume,
    stop,
    discard,
  };
}
