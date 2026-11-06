import { CleanComparisonTimeline } from "./CleanComparisonTimeline";
import { useEffect, useRef, useState } from "react";
import {
  Fingerprint,
  Loader2,
  Pause,
  Play,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type {
  CleanSource,
  UploadedComparison,
} from "@contracts/clean-workspace";
import { cleanMediaUrl } from "@/lib/clean-workspace";
import { fmtBytes } from "@/lib/exports";
import { FingerprintResults } from "./FingerprintResults";
import { MetadataList } from "./CleanMetadataList";

interface ComparisonVideo {
  key: string;
  name: string;
  preview?: string;
  source?: CleanSource;
  upload: string;
  percent: number;
  operation?: string;
  error?: string;
}
const button =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40";
const videoUrl = (video: ComparisonVideo) =>
  video.preview || (video.source ? cleanMediaUrl(video.source.id) : undefined);

export function CleanUploadedComparison({
  original,
  comparison,
  candidates,
  result,
  onSelect,
  onUpload,
  onMeasure,
  onDelete,
  onRetry,
}: {
  original: ComparisonVideo;
  comparison?: ComparisonVideo;
  candidates: ComparisonVideo[];
  result?: UploadedComparison;
  onSelect: (key: string) => void;
  onUpload: () => void;
  onMeasure: () => void;
  onDelete: () => void;
  onRetry: (key: string) => void;
}) {
  const busy = Boolean(original.operation || comparison?.operation);
  const measuring =
    original.operation === "comparing" || comparison?.operation === "comparing";
  const measured =
    result?.beforeId === original.source?.id &&
    result?.afterId === comparison?.source?.id
      ? result
      : undefined;
  const [seekPair, setSeekPair] = useState<{
    pair: string;
    original: number;
    comparison: number;
  }>();
  const beforeUrl = videoUrl(original),
    afterUrl = comparison && videoUrl(comparison);
  return (
    <main className="mx-auto max-w-6xl min-w-0">
      <section className="mb-4 flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Compare two uploaded videos</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            Compare the files as uploaded. Your live editing settings stay saved
            in this workspace.
          </p>
          {candidates.length > 0 && (
            <label className="mt-4 block max-w-lg text-xs text-zinc-400">
              Second video
              <select
                aria-label="Second video"
                value={comparison?.key ?? ""}
                disabled={busy}
                onChange={(event) => onSelect(event.target.value)}
                className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-sm text-zinc-200"
              >
                <option value="" disabled>
                  Choose an uploaded video
                </option>
                {candidates.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                    {item.upload !== "ready" ? ` · ${item.upload}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className={button + " text-violet-200"}
        >
          <UploadCloud className="h-4 w-4" /> Upload second video
        </button>
      </section>
      {[original, comparison]
        .filter((item): item is ComparisonVideo => Boolean(item))
        .map((item) => (
          <div key={item.key}>
            {["queued", "uploading"].includes(item.upload) && (
              <p
                role="status"
                className="mb-3 flex items-center gap-2 text-xs text-violet-300"
              >
                <Loader2 className="h-4 w-4 animate-spin" /> {item.name} ·{" "}
                {item.upload === "queued"
                  ? "Waiting to upload…"
                  : `Uploading ${item.percent}%`}
              </p>
            )}
            {item.error && (
              <p
                role="alert"
                className="mb-3 rounded-lg border border-red-500/20 p-3 text-sm text-red-300"
              >
                {item.name}: {item.error}
                {item.upload === "error" && (
                  <button
                    type="button"
                    onClick={() => onRetry(item.key)}
                    className="ml-3 underline"
                  >
                    Retry upload
                  </button>
                )}
              </p>
            )}
          </div>
        ))}
      {beforeUrl && afterUrl && comparison ? (
        <SyncedVideos
          key={original.key + comparison.key}
          seekPair={
            seekPair?.pair === original.key + ":" + comparison.key
              ? seekPair
              : undefined
          }
          before={beforeUrl}
          after={afterUrl}
          beforeName={original.name}
          afterName={comparison.name}
        />
      ) : (
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className="flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-zinc-800 bg-zinc-900/20 px-6 text-center hover:border-violet-500/50"
        >
          <UploadCloud className="h-8 w-8 text-violet-400" />
          <span>Upload a second version to compare with {original.name}</span>
          <span className="text-xs text-zinc-500">
            Both uploads remain available. No new video copy is created for
            comparison.
          </span>
        </button>
      )}
      <CleanComparisonTimeline
        key={original.key + ":" + comparison?.key}
        measurement={measured?.fingerprints.comparison}
        onSeek={(originalTime, comparisonTime) =>
          setSeekPair({
            pair: original.key + ":" + comparison?.key,
            original: originalTime,
            comparison: comparisonTime,
          })
        }
      />
      <section className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">File comparison</h3>
            <p className="mt-1 text-xs text-zinc-500">
              File details appear after upload. Measure visual fingerprints when
              ready.
            </p>
          </div>
          <button
            type="button"
            onClick={onMeasure}
            disabled={!original.source || !comparison?.source || busy}
            className={button + " border-violet-500/30 text-violet-200"}
          >
            {measuring ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="h-4 w-4" />
            )}
            {measuring ? "Comparing…" : "Measure fingerprints"}
          </button>
        </div>
        {original.source && comparison?.source && (
          <>
            <p className="mt-4 rounded-lg bg-violet-500/5 p-3 text-sm text-violet-200">
              {original.source.md5 === comparison.source.md5
                ? "Identical file MD5 hashes"
                : "Different file MD5 hashes"}
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <FileDetails label="Original" source={original.source} />
              <FileDetails label="Second upload" source={comparison.source} />
            </div>
          </>
        )}
        {measuring && (
          <p role="status" className="mt-4 text-xs text-violet-300">
            Analyzing both uploaded files… You can still preview them while this
            runs.
          </p>
        )}
        {measured && original.source && comparison?.source && (
          <FingerprintResults
            report={measured.fingerprints}
            name={original.name}
            comparisonLabel={comparison.name}
            md5={{ before: original.source.md5, after: comparison.source.md5 }}
          />
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
          PDQ compares matching timestamps over the shorter video. TMK+PDQF
          compares both full videos. The comparison timeline separately searches
          sampled frames across timestamps to locate moved footage.
        </p>
      </section>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 p-4">
        <p className="max-w-2xl text-xs leading-relaxed text-zinc-500">
          Uploads are temporary and expire after one hour of inactivity. Done &
          delete both removes both selected uploads and their temporary server
          files now. Your local files stay unchanged.
        </p>
        <button
          type="button"
          onClick={onDelete}
          disabled={!comparison || busy}
          className={button + " text-zinc-300"}
        >
          <Trash2 className="h-4 w-4" /> Done & delete both
        </button>
      </div>
    </main>
  );
}

function FileDetails({
  label,
  source,
}: {
  label: string;
  source: CleanSource;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-zinc-800 p-3">
      <h4 className="text-xs text-zinc-500">{label}</h4>
      <p className="mt-1 break-all text-sm font-medium">{source.name}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-zinc-500">Size</dt>
          <dd className="mt-1">{fmtBytes(source.bytes)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Duration</dt>
          <dd className="mt-1">{source.duration?.toFixed(2) ?? "—"}s</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Dimensions</dt>
          <dd className="mt-1">
            {source.width ?? "—"} × {source.height ?? "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-3 break-all font-mono text-[11px] text-zinc-400">
        MD5 {source.md5}
      </p>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-violet-300">
          Metadata · {source.metadata.length} entries
        </summary>
        <div className="mt-2">
          <MetadataList items={source.metadata} />
        </div>
      </details>
    </div>
  );
}

function SyncedVideos({
  seekPair,
  before,
  after,
  beforeName,
  afterName,
}: {
  seekPair?: { original: number; comparison: number };
  before: string;
  after: string;
  beforeName: string;
  afterName: string;
}) {
  const left = useRef<HTMLVideoElement>(null),
    right = useRef<HTMLVideoElement>(null);
  const intent = useRef(false);
  const playAttempt = useRef(0);
  const [durations, setDurations] = useState([0, 0]);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState("mute");
  const [error, setError] = useState<string>();
  const [unplayable, setUnplayable] = useState(false);
  const [offset, setOffset] = useState(0);
  const duration = Math.min(durations[0], durations[1] - offset);
  const startTime = Math.max(0, -offset);
  function pause() {
    playAttempt.current++;
    intent.current = false;
    left.current?.pause();
    right.current?.pause();
    if (left.current && right.current && duration > 0) {
      const at = Math.min(left.current.currentTime, duration);
      left.current.currentTime = at;
      right.current.currentTime = at + offset;
      setSeconds(at);
    }
    setPlaying(false);
    setBuffering(false);
  }
  function resume() {
    const a = left.current,
      b = right.current;
    if (!intent.current || !a || !b || a.readyState < 3 || b.readyState < 3)
      return;
    const attempt = ++playAttempt.current;
    void Promise.all([a.play(), b.play()])
      .then(() => {
        if (attempt !== playAttempt.current) return;
        if (!intent.current) {
          a.pause();
          b.pause();
          return;
        }
        setPlaying(true);
        setBuffering(false);
      })
      .catch(() => {
        if (attempt !== playAttempt.current || !intent.current) return;
        pause();
        setError(
          "Playback could not start. Try playing again, or compare the file measurements below.",
        );
      });
  }
  function wait() {
    if (!intent.current) return;
    playAttempt.current++;
    left.current?.pause();
    right.current?.pause();
    setPlaying(false);
    setBuffering(true);
  }
  function seek(value: number) {
    pause();
    if (left.current) left.current.currentTime = value;
    if (right.current) right.current.currentTime = value + offset;
    setSeconds(value);
  }
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const tick = () => {
      const a = left.current,
        b = right.current;
      if (!a || !b) return;
      if (a.currentTime >= duration || a.ended || b.ended) {
        intent.current = false;
        a.pause();
        b.pause();
        setPlaying(false);
        a.currentTime = duration;
        b.currentTime = duration + offset;
        setSeconds(duration);
        return;
      }
      if (!b.seeking && Math.abs(b.currentTime - a.currentTime - offset) > 0.08)
        b.currentTime = a.currentTime + offset;
      setSeconds(a.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, offset]);
  useEffect(() => {
    if (
      !seekPair ||
      !left.current ||
      !right.current ||
      !durations.every((d) => d > 0)
    )
      return;
    pause();
    const original = Math.min(seekPair.original, durations[0] - 0.001);
    const comparison = Math.min(seekPair.comparison, durations[1] - 0.001);
    setOffset(comparison - original);
    left.current.currentTime = original;
    right.current.currentTime = comparison;
    setSeconds(original);
    // Commands run once when both metadata tracks are ready; pause uses the previous alignment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekPair, durations[0], durations[1]]);
  // Prevent pending play promises from restarting media after changing the pair.
  useEffect(
    () => () => {
      intent.current = false;
    },
    [],
  );
  return (
    <section
      aria-label="Uploaded video previews"
      className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"
    >
      {offset !== 0 && (
        <p className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-violet-300">
          Showing matched moments · second video offset {offset.toFixed(2)}s{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              pause();
              setOffset(0);
              if (left.current) left.current.currentTime = 0;
              if (right.current) right.current.currentTime = 0;
              setSeconds(0);
            }}
          >
            Reset alignment
          </button>
        </p>
      )}
      <div className="grid gap-px bg-zinc-800 md:grid-cols-2">
        {[
          {
            url: before,
            name: beforeName,
            ref: left,
            label: "Original",
            audio: "original",
          },
          {
            url: after,
            name: afterName,
            ref: right,
            label: "Second upload",
            audio: "second",
          },
        ].map((item, index) => (
          <div key={item.label} className="min-w-0 bg-zinc-950">
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="shrink-0 text-violet-300">{item.label}</span>
              <span className="truncate text-zinc-500">{item.name}</span>
            </div>
            <video
              ref={item.ref}
              src={item.url}
              aria-label={item.label + " video"}
              playsInline
              preload="auto"
              muted={audio !== item.audio}
              className="aspect-video w-full bg-black object-contain"
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                setDurations((values) =>
                  values.map((old, i) =>
                    i === index && Number.isFinite(value) ? value : old,
                  ),
                );
              }}
              onCanPlay={resume}
              onWaiting={wait}
              onEnded={() => seek(duration)}
              onError={() => {
                pause();
                setUnplayable(true);
                setError(
                  "Your browser cannot preview one of these video formats. File and fingerprint comparisons are still available below.",
                );
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 p-3">
        <button
          type="button"
          disabled={!duration || unplayable}
          aria-label={
            playing || buffering ? "Pause both videos" : "Play both videos"
          }
          onClick={() => {
            if (intent.current) pause();
            else {
              setError(undefined);
              if (seconds >= duration) seek(startTime);
              intent.current = true;
              setBuffering(true);
              resume();
            }
          }}
          className="rounded-lg bg-violet-600 p-2 text-white disabled:opacity-40"
        >
          {buffering ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </button>
        <input
          type="range"
          aria-label="Seek both videos"
          min={startTime}
          max={duration || 0}
          step={0.001}
          value={Math.min(seconds, duration)}
          disabled={!duration}
          onChange={(event) => seek(Number(event.target.value))}
          className="min-w-24 flex-1 accent-violet-500"
        />
        <span className="text-xs tabular-nums text-zinc-400">
          {seconds.toFixed(2)} / {duration.toFixed(2)}s
        </span>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Audio
          <select
            aria-label="Comparison audio"
            value={audio}
            onChange={(event) => setAudio(event.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-300"
          >
            <option value="mute">Muted</option>
            <option value="original">Original</option>
            <option value="second">Second upload</option>
          </select>
        </label>
      </div>
      <p className="px-3 pb-3 text-[11px] text-zinc-500">
        {offset === 0
          ? "Shared playback uses matching timestamps. Select a matched timeline sample to align different source moments."
          : "Playback keeps the selected time offset. This is a local alignment; different playback rates can still drift."}
      </p>
      {error && (
        <p role="alert" className="px-3 pb-3 text-xs text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
