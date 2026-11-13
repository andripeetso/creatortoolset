import { SPOKEN_LANGUAGES, languageName } from "@contracts/voice";

/**
 * The language spoken in a project's or an edit's videos: one code, or "" for the person's own languages (Settings → AI
 * → Voice). Saved as `languages: [code]` (none: []).
 */
export function LanguageSelect({ id, value, onChange, disabled, className, placeholder = "My languages (Settings → Voice)" }: {
  id?: string;
  /** the label of "" */
  placeholder?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{placeholder}</option>
      {SPOKEN_LANGUAGES.map((c) => (
        <option key={c} value={c}>
          {languageName(c)}
        </option>
      ))}
    </select>
  );
}
