/** Hand the browser a text file to save. */
export function downloadText(filename: string, text: string, mime = "text/markdown;charset=utf-8"): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Hand the browser a file to save. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugFilename(title: string, ext = "md"): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "workshop"}.${ext}`;
}
