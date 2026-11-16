import { LIBRARY_UPLOADS, type LibrarySummary, type LibraryUpload } from "@contracts/library";
import { Row, SettingsSelect } from "@/components/settings/ui";
import { updateLibrary } from "@/lib/library";

/**
 * What a file added from a computer the server is not on sends to the server (settings.upload, Off by default): nothing
 * (it is read where it is on the Mac, lib/onMac.ts), its proxy only, or the video file and its proxy. One stored value
 * per library (= per workspace), shown in the library's settings, Settings → Media Library and a new workspace's form.
 * On the server's own computer the same three words are the cloud copy (../LibraryStorage.tsx).
 */

export const UPLOAD_LABEL = "Upload to the server";
const WORDS: Record<LibraryUpload, string> = { none: "Off", proxies: "Proxies only", all: "Video files and proxies" };
export const UPLOAD_OPTIONS = LIBRARY_UPLOADS.map((value) => ({ value, label: WORDS[value] }));
const DETAIL: Record<LibraryUpload, string> = {
  none: "Video files stay on your computer; the server keeps their pictures and details",
  proxies: "A smaller copy of each video for playback; the video file stays on your computer",
  all: "Each video file and a smaller copy for playback",
};

export function UploadSelect({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const value = library.settings.upload;
  return (
    <Row
      id="library-upload"
      title={UPLOAD_LABEL}
      description={DETAIL[value]}
      control={
        <SettingsSelect
          label={UPLOAD_LABEL}
          value={value}
          options={UPLOAD_OPTIONS}
          disabled={!!library.readOnly}
          onValueChange={(v) =>
            void updateLibrary(library.id, { settings: { upload: v as LibraryUpload } })
              .then(onChange)
              .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
          }
        />
      }
    />
  );
}
