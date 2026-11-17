import { LIBRARY_UPLOADS, type LibrarySummary, type LibraryUpload } from "@contracts/library";
import { Row, SettingsSelect } from "@/components/settings/ui";
import { updateLibrary } from "@/lib/library";

/**
 * What a file added from a computer the server is not on sends to the server (settings.upload, Off by default): nothing
 * (it is read where it is on the Mac, lib/onMac.ts), its proxy only, or the video file and its proxy. One stored value
 * per library (= per workspace). `UploadRow` is the one control for it, wherever it is drawn: the library's settings
 * and Settings → Media Library (`UploadSelect`, saved at once), a new workspace's form, and on the server's own
 * computer the cloud copy, which is the same three words (../LibraryStorage.tsx). Finals (a project's finished file read
 * from its folder) have a row of their own beside it (settings.finalsUpload, full files by default).
 */

export const UPLOAD_LABEL = "Upload to the server";
const WORDS: Record<LibraryUpload, string> = { none: "Off", proxies: "Proxies only", all: "Video files and proxies" };
export const UPLOAD_OPTIONS = LIBRARY_UPLOADS.map((value) => ({ value, label: WORDS[value] }));
const DETAIL: Record<LibraryUpload, string> = {
  none: "Video files stay on the computer.",
  proxies: "A smaller copy of each video is uploaded for playback.",
  all: "Each video file is uploaded, with a smaller copy for playback.",
};
export const FINALS_UPLOAD_LABEL = "Finals upload";
const FINALS_DETAIL: Record<LibraryUpload, string> = {
  none: "Finals stay on the computer.",
  proxies: "A smaller copy of each final is uploaded for playback.",
  all: "Each final is uploaded whole, so a phone can download it.",
};

/**
 * The row itself. `off`: values that cannot be picked here (a library that holds files keeps where they are).
 * `description`: said in place of the value's own sentence (how many video files are where, ./LibrarySettings.tsx).
 */
export function UploadRow({ value, onChange, disabled, off = [], description, finals = false }: { value: LibraryUpload; onChange: (v: LibraryUpload) => void; disabled?: boolean; off?: readonly LibraryUpload[]; description?: string; finals?: boolean }) {
  const label = finals ? FINALS_UPLOAD_LABEL : UPLOAD_LABEL;
  return (
    <Row
      id={finals ? "finals-upload" : "library-upload"}
      title={label}
      description={description ?? (finals ? FINALS_DETAIL : DETAIL)[value]}
      control={
        <SettingsSelect
          label={label}
          value={value}
          options={UPLOAD_OPTIONS.filter((o) => o.value === value || !off.includes(o.value))}
          disabled={disabled}
          onValueChange={(v) => onChange(v as LibraryUpload)}
        />
      }
    />
  );
}

/** The footage row and the finals row, each saved at once. */
export function UploadSelect({ library, onChange, onError, description }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void; description?: string }) {
  const save = (settings: { upload: LibraryUpload } | { finalsUpload: LibraryUpload }) =>
    void updateLibrary(library.id, { settings })
      .then(onChange)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  return (
    <>
      <UploadRow value={library.settings.upload} description={description} disabled={!!library.readOnly} onChange={(upload) => save({ upload })} />
      <UploadRow finals value={library.settings.finalsUpload ?? "all"} disabled={!!library.readOnly} onChange={(finalsUpload) => save({ finalsUpload })} />
    </>
  );
}
