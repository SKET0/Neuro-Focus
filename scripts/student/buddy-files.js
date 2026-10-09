// Files for NeuroBuddy, read on this device. Documents become text (PDF, Word .docx, PowerPoint
// .pptx, plain text, Markdown, CSV); pictures (JPG, PNG, WebP) are shrunk to a small JPEG. Only the
// resulting text or picture is sent to the AI service, and only when the student asks something.
// The readers for PDF, Word and PowerPoint load from cdnjs the first time one is needed, checked
// against fixed integrity hashes so a changed file is refused.

const CDN = "https://cdnjs.cloudflare.com/ajax/libs";
const LIBS = {
  pdf: { url: `${CDN}/pdf.js/3.11.174/pdf.min.js`, integrity: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e", global: "pdfjsLib" },
  pdfWorker: { url: `${CDN}/pdf.js/3.11.174/pdf.worker.min.js`, integrity: "sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2" },
  mammoth: { url: `${CDN}/mammoth/1.6.0/mammoth.browser.min.js`, integrity: "sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz", global: "mammoth" },
  jszip: { url: `${CDN}/jszip/3.10.1/jszip.min.js`, integrity: "sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG", global: "JSZip" }
};

export const MAX_FILE_MB = 15;
export const MAX_DOCUMENT_CHARS = 30000;
const PICTURE_SIDE = 1600;
const EXTENSIONS = {
  pdf: "pdf", docx: "word", pptx: "slides", txt: "text", md: "text", markdown: "text", csv: "text",
  jpg: "picture", jpeg: "picture", png: "picture", webp: "picture"
};
export const ACCEPT = Object.keys(EXTENSIONS).map((ext) => `.${ext}`).join(",");
export const FILE_TYPES_TEXT = "PDF, Word (.docx), PowerPoint (.pptx), text, Markdown or CSV files, and pictures (JPG, PNG, WebP)";

const extension = (name) => (/\.([a-z0-9]+)$/i.exec(name || "")?.[1] || "").toLowerCase();
export const kindOf = (file) => EXTENSIONS[extension(file.name)] || "";

const loading = new Map();
function loadScript(lib) {
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  if (!loading.has(lib.url)) {
    loading.set(lib.url, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = lib.url;
      script.integrity = lib.integrity;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error("reader missing")));
      script.onerror = () => { loading.delete(lib.url); reject(new Error("reader failed to load")); };
      document.head.append(script);
    }));
  }
  return loading.get(lib.url);
}

let pdfReady = null;
async function pdfLib() {
  if (!pdfReady) {
    pdfReady = (async () => {
      const lib = await loadScript(LIBS.pdf);
      // A worker must come from this site: fetch the checked file and run it from a local blob.
      const response = await fetch(LIBS.pdfWorker.url, { integrity: LIBS.pdfWorker.integrity, mode: "cors", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("reader failed to load");
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(await response.blob());
      return lib;
    })().catch((error) => { pdfReady = null; throw error; });
  }
  return pdfReady;
}

const tidy = (text) => text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

async function readPdf(file) {
  const lib = await pdfLib();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  let length = 0;
  for (let number = 1; number <= pdf.numPages && length < MAX_DOCUMENT_CHARS; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`).join("");
    pages.push(`[Page ${number}]\n${text}`);
    length += text.length;
  }
  await pdf.destroy();
  return pages.join("\n\n");
}

async function readWord(file) {
  const mammoth = await loadScript(LIBS.mammoth);
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value || "";
}

async function readSlides(file) {
  const JSZip = await loadScript(LIBS.jszip);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const parser = new DOMParser();
  const parts = [];
  for (const [index, name] of slides.entries()) {
    const xml = parser.parseFromString(await zip.file(name).async("string"), "application/xml");
    const paragraphs = [...xml.getElementsByTagName("a:p")].map((p) => [...p.getElementsByTagName("a:t")].map((t) => t.textContent).join("")).filter(Boolean);
    if (paragraphs.length) parts.push(`[Slide ${index + 1}]\n${paragraphs.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function readPicture(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.85);
}

// -> { kind: "document", name, docKind, text, truncated } | { kind: "picture", name, dataUrl }
// Throws an Error with a message meant for the student.
export async function readFile(file) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`“${file.name}” can’t be read. Use ${FILE_TYPES_TEXT}.`);
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`“${file.name}” is larger than ${MAX_FILE_MB} MB.`);
  if (!file.size) throw new Error(`“${file.name}” is empty.`);
  try {
    if (kind === "picture") return { kind: "picture", name: file.name, dataUrl: await readPicture(file) };
    const raw = kind === "pdf" ? await readPdf(file) : kind === "word" ? await readWord(file) : kind === "slides" ? await readSlides(file) : await file.text();
    const text = tidy(raw);
    if (text.length < 20) {
      throw new Error(kind === "pdf"
        ? `No text was found in “${file.name}”. If it’s a scan, take a photo of the page and add that instead.`
        : `No text was found in “${file.name}”.`);
    }
    return { kind: "document", name: file.name, docKind: kind, text: text.slice(0, MAX_DOCUMENT_CHARS), truncated: text.length > MAX_DOCUMENT_CHARS };
  } catch (error) {
    if (/^No text|can’t be read|larger than|is empty/.test(error?.message || "")) throw error;
    if (/reader failed|reader missing/.test(error?.message || "")) throw new Error("The file reader couldn’t load. Check your internet connection and try again.");
    if (/password/i.test(error?.message || "")) throw new Error(`“${file.name}” is password-protected. Save a copy without a password and add that.`);
    throw new Error(`“${file.name}” couldn’t be read. It may be damaged, or saved in an older format.`);
  }
}
