import { useEffect, useState } from "react";
/** Small browser-only previews; never uploads or saves another video. */
export function useClipThumbnails(url: string, duration: number) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const wait = (event: string) =>
      new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          video.removeEventListener(event, ready);
          video.removeEventListener("error", failed);
          controller.signal.removeEventListener("abort", failed);
          if (error) reject(error);
          else resolve();
        };
        const ready = () => finish();
        const failed = () => finish(new Error("Thumbnail unavailable"));
        const timer = setTimeout(failed, 5000);
        video.addEventListener(event, ready, { once: true });
        video.addEventListener("error", failed, { once: true });
        controller.signal.addEventListener("abort", failed, { once: true });
      });
    void (async () => {
      const ready = wait("loadeddata");
      video.src = url;
      await ready;
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 72;
      const context = canvas.getContext("2d");
      if (!context) return;
      const images: string[] = [],
        count = Math.min(16, Math.max(1, Math.ceil(duration / 2)));
      for (let i = 0; i < count; i++) {
        controller.signal.throwIfAborted();
        const at = (duration * i) / count;
        if (Math.abs(video.currentTime - at) > 0.01) {
          const sought = wait("seeked");
          video.currentTime = at;
          await sought;
        }
        context.fillStyle = "#09090b";
        context.fillRect(0, 0, 128, 72);
        const scale = Math.min(128 / video.videoWidth, 72 / video.videoHeight);
        const width = video.videoWidth * scale,
          height = video.videoHeight * scale;
        context.drawImage(
          video,
          (128 - width) / 2,
          (72 - height) / 2,
          width,
          height,
        );
        images.push(canvas.toDataURL("image/jpeg", 0.65));
      }
      if (!controller.signal.aborted) setFrames(images);
    })().catch(() => {
      /* Timeline remains usable for browser-incompatible codecs. */
    });
    return () => {
      controller.abort();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, duration]);
  return frames;
}
