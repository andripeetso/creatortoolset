/**
 * A PDF's text, page by page, read in the browser (pdf.js, loaded only when a PDF is dropped): the server keeps text,
 * and the AI files and reads the text by line. "[page N]" lines keep the pages findable.
 */
async function openPdf(file: File) {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
}

export async function pdfText(file: File, onPage?: (n: number, total: number) => void): Promise<string> {
  const task = await openPdf(file);
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      pages.push(`[page ${i}]\n${text.replace(/[ \t]+\n/g, "\n").trim()}`);
      onPage?.(i, doc.numPages);
    }
    return pages.join("\n\n");
  } finally {
    void task.destroy();
  }
}

/** True when the pages hold no words at all: a scan, which needs OCR first. */
export const onlyPageMarks = (text: string) => !text.replace(/\[page \d+\]/g, "").trim();

/** A scan's pages as JPEGs (base64, ~1400 px tall), for the user's AI to read. */
export async function pdfPages(file: File, max: number, onPage?: (n: number, total: number) => void): Promise<string[]> {
  const task = await openPdf(file);
  try {
    const doc = await task.promise;
    if (doc.numPages > max) throw new Error(`${file.name} has ${doc.numPages} scanned pages: up to ${max} are read`);
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 1400 / base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      out.push(canvas.toDataURL("image/jpeg", 0.7).split(",")[1]!);
      onPage?.(i, doc.numPages);
    }
    return out;
  } finally {
    void task.destroy();
  }
}
