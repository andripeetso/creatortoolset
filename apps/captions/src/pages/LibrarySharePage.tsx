import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Download, Lock } from "lucide-react";
import type { SharedView } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A Media Library share link (/library/s/:token): no account. A locked link asks for its password first; the unlock is
 * a cookie the server sets, so the players below can stream without the password in their URLs.
 */
export default function LibrarySharePage() {
  const { token = "" } = useParams();
  const [view, setView] = useState<SharedView | null>(null);
  const [gone, setGone] = useState(false);
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);

  const load = () =>
    fetch(`/api/library/s/${token}`)
      .then((r) => (r.ok ? (r.json() as Promise<SharedView>) : null))
      .then((v) => (v ? setView(v) : setGone(true)))
      .catch(() => setGone(true));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch(`/api/library/s/${token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (r.ok) {
      setWrong(false);
      await load();
    } else setWrong(true);
  };

  if (gone) return <p className="p-8 text-center text-sm text-zinc-500">This link is off, has expired, or was never real.</p>;
  if (!view) return <div aria-hidden="true" className="min-h-dvh" />; // no spinner: the page paints when its list arrives

  if (view.locked) {
    return (
      <form onSubmit={unlock} className="mx-auto mt-24 flex w-full max-w-xs flex-col gap-3 px-4">
        <Lock className="mx-auto h-6 w-6 text-zinc-500" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" />
        <Button type="submit">Open</Button>
        {wrong && <p className="text-center text-xs text-red-400">That password is not right.</p>}
      </form>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
      {view.name && <h1 className="text-lg font-semibold">{view.name}</h1>}
      {view.items.length === 0 && <p className="text-sm text-zinc-500">Nothing is shared here any more.</p>}
      {view.items.map((item) => (
        <figure key={item.id} className="flex flex-col gap-2">
          {item.kind === "audio" && <audio controls preload="metadata" src={item.playUrl} className="w-full" />}
          {item.kind === "image" && <img src={item.playUrl} alt={item.title} className="w-full rounded-lg" />}
          {item.kind === "video" && (
            <video controls playsInline preload="metadata" src={item.playUrl} poster={item.thumbUrl} className="w-full rounded-lg bg-black" />
          )}
          <figcaption className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate">{item.title}</span>
            {item.sourceUrl && (
              <a href={item.sourceUrl} download className="inline-flex shrink-0 items-center gap-1.5 text-zinc-300 underline-offset-4 hover:underline">
                <Download className="h-4 w-4" />
                Download
              </a>
            )}
          </figcaption>
        </figure>
      ))}
    </main>
  );
}
