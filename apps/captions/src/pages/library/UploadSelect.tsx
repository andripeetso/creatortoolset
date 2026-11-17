import { LIBRARY_UPLOADS, type LibrarySummary, type LibraryUpload } from "@contracts/library";
import { Row, SettingsSelect } from "@/components/settings/ui";
import { updateLibrary } from "@/lib/library";

/**
 * What a file added from a computer the server is not on sends to the server (settings.upload, Off by default): nothing
 * (it is read where it is on the Mac, lib/onMac.ts), its proxy only, or the video file and its proxy. One stored value
 * per library (= per workspace). `UploadRow` is the one control for it, wherever it is drawn: the library's settings
 * and Settings → Media Library (`UploadSelect`, saved at once), a new workspace's form, and on the server's own
 * computer the cloud copy, which is the same three words (../LibraryStorage.tsx). Finals (a project's finished file read
 * from its folder) have a row of their own beside it (settings.finalsUpload, full files by default), in their own words.
 */

export const UPLOAD_LABEL = "Upload to the server";
const WORDS: Record<LibraryUpload, string> = { none: "Off", proxies: "Proxies only", all: "Originals and proxies" };
export const UPLOAD_OPTIONS = LIBRARY_UPLOADS.map((value) => ({ value, label: WORDS[value] }));
const DETAIL: Record<LibraryUpload, string> = {
  none: "Videos stay on the computer they were added from and play only there.",
  proxies: "A proxy of each video is uploaded so it plays anywhere, and the original stays on the computer.",
  all: "Each video is uploaded with its proxy, so it plays and downloads anywhere.",
};
/** A final is one finished file, so its choices say copy and file, not proxy and original. */
const FINALS_WORDS: Record<LibraryUpload, string> = { none: "Off", proxies: "Smaller copies", all: "Full files" };
const FINALS_OPTIONS = LIBRARY_UPLOADS.map((value) => ({ value, label: FINALS_WORDS[value] }));
const FINALS_DETAIL: Record<LibraryUpload, string> = {
  none: "Finished videos stay on the computer they were made on and play only there.",
  proxies: "A smaller copy of each finished video is uploaded so it plays anywhere.",
  all: "Each finished video is uploaded whole, so it can be downloaded on a phone.",
};

/**
 * The row itself, titled Footage or Finals (`title` where no Uploads section names it, the new workspace's form). `off`:
 * values that cannot be picked here (a library that holds files keeps where they are). `facts`: how many video files
 * are where (./LibrarySettings.tsx), said under the value's own sentence.
 */
export function UploadRow({ value, onChange, disabled, off = [], facts, finals = false, title }: { value: LibraryUpload; onChange: (v: LibraryUpload) => void; disabled?: boolean; off?: readonly LibraryUpload[]; facts?: string; finals?: boolean; title?: string }) {
  const name = title ?? (finals ? "Finals" : "Footage");
  return (
    <Row
      id={finals ? "finals-upload" : "library-upload"}
      title={name}
      description={(finals ? FINALS_DETAIL : DETAIL)[value]}
      status={facts}
      control={
        <SettingsSelect
          label={`${finals ? "Finals" : "Footage"} upload`}
          value={value}
          options={(finals ? FINALS_OPTIONS : UPLOAD_OPTIONS).filter((o) => o.value === value || !off.includes(o.value))}
          disabled={disabled}
          onValueChange={(v) => onChange(v as LibraryUpload)}
        />
      }
    />
  );
}

/** The footage row and the finals row, each saved at once. */
export function UploadSelect({ library, onChange, onError, facts }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void; facts?: string }) {
  const save = (settings: { upload: LibraryUpload } | { finalsUpload: LibraryUpload }) =>
    void updateLibrary(library.id, { settings })
      .then(onChange)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  return (
    <>
      <UploadRow value={library.settings.upload} facts={facts} disabled={!!library.readOnly} onChange={(upload) => save({ upload })} />
      <UploadRow finals value={library.settings.finalsUpload ?? "all"} disabled={!!library.readOnly} onChange={(finalsUpload) => save({ finalsUpload })} />
    </>
  );
}
