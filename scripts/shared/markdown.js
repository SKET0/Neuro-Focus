// Small, safe Markdown support for notes and NeuroBuddy replies.
// renderMarkdown(text) builds DOM nodes; toMarkdown(element) turns edited notes back into text.
// Covers what NeuroBuddy writes and the notes editor makes: headings, paragraphs, bullet and
// numbered lists (nested by indent), quotes, rules, **bold**, *italic* and `code`.
// Text is only ever set with textContent, so nothing in a note is parsed as HTML.

const PUNCTUATION = /[!-/:-@[-`{-~]/;

// ---------- Markdown -> DOM ----------
function findClosing(text, marker, from) {
  for (let j = from; j < text.length; j += 1) {
    if (text[j] === "\\") { j += 1; continue; }
    if (text.startsWith(marker, j) && text[j - 1] !== " " && (marker.length > 1 || text[j + 1] !== marker)) return j;
  }
  return -1;
}

function appendInline(parent, text) {
  let plain = "";
  const flush = () => { if (plain) { parent.append(plain); plain = ""; } };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "\\" && PUNCTUATION.test(text[i + 1] || "")) { plain += text[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        parent.append(code);
        i = end + 1;
        continue;
      }
    }
    const double = text.startsWith("**", i) ? "**" : text.startsWith("__", i) ? "__" : "";
    const wordStart = i === 0 || !/\w/.test(text[i - 1]);
    if (double && text[i + 2] && text[i + 2] !== " " && (double === "**" || wordStart)) {
      const end = findClosing(text, double, i + 3);
      if (end > 0) {
        flush();
        const strong = document.createElement("strong");
        appendInline(strong, text.slice(i + 2, end));
        parent.append(strong);
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || (ch === "_" && wordStart)) && text[i + 1] && text[i + 1] !== " " && text[i + 1] !== ch) {
      const end = findClosing(text, ch, i + 2);
      if (end > 0 && (ch === "*" || !/\w/.test(text[end + 1] || ""))) {
        flush();
        const em = document.createElement("em");
        appendInline(em, text.slice(i + 1, end));
        parent.append(em);
        i = end + 1;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
}

const indentWidth = (space) => space.replace(/\t/g, "    ").length;

export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let lists = []; // open lists: { indent, el }
  let quote = null;
  const closeLists = () => { lists = []; };
  const block = (tag, text) => {
    const el = document.createElement(tag);
    appendInline(el, text);
    fragment.append(el);
    return el;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { closeLists(); quote = null; continue; }

    if (/^\s*```/.test(line)) {
      closeLists();
      const pre = document.createElement("pre");
      const body = [];
      for (index += 1; index < lines.length && !/^\s*```/.test(lines[index]); index += 1) body.push(lines[index]);
      pre.textContent = body.join("\n");
      fragment.append(pre);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { closeLists(); quote = null; block(heading[1].length <= 2 ? "h2" : "h3", heading[2]); continue; }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { closeLists(); fragment.append(document.createElement("hr")); continue; }

    const item = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (item) {
      quote = null;
      const indent = indentWidth(item[1]);
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      while (lists.length && indent < lists[lists.length - 1].indent) lists.pop();
      let top = lists[lists.length - 1];
      if (top && indent === top.indent && top.el.tagName.toLowerCase() !== tag) { lists.pop(); top = lists[lists.length - 1]; }
      if (!top || indent > top.indent) {
        // A new list: nested inside the previous item when indented further, otherwise top-level.
        const list = document.createElement(tag);
        if (tag === "ol" && Number.parseInt(item[2], 10) > 1) list.start = Number.parseInt(item[2], 10);
        const parentItem = top?.el.lastElementChild;
        if (parentItem) parentItem.append(list);
        else { fragment.append(list); lists = []; }
        lists.push({ indent, el: list });
        top = lists[lists.length - 1];
      }
      const li = document.createElement("li");
      appendInline(li, item[3].replace(/^\[ \]\s+/, "☐ ").replace(/^\[[xX]\]\s+/, "☑ "));
      top.el.append(li);
      continue;
    }

    // An indented line right after a list item continues that item.
    if (lists.length && /^\s+\S/.test(line)) {
      const li = lists[lists.length - 1].el.lastElementChild;
      if (li) { li.append(" "); appendInline(li, line.trim()); continue; }
    }
    closeLists();

    const quoted = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoted) {
      if (!quote) { quote = document.createElement("blockquote"); fragment.append(quote); }
      const p = document.createElement("p");
      appendInline(p, quoted[1]);
      quote.append(p);
      continue;
    }
    quote = null;

    // Tables aren't supported: show each row as a line of text.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
      block("p", line.split("|").map((cell) => cell.trim()).filter(Boolean).join("  ·  "));
      continue;
    }
    block("p", line.trim());
  }
  return fragment;
}

// Plain text for previews and search.
export function markdownToPlain(source) {
  return String(source || "")
    .replace(/^\s*(#{1,6}|[-*+]|\d{1,3}[.)]|>)\s+/gm, "")
    .replace(/(?<!\\)(\*+|`)/g, "")
    .replace(/(^|\W)_{1,2}(\S[^_]*?)_{1,2}(?=\W|$)/g, "$1$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- DOM -> Markdown ----------
const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "HR"]);

const escapeText = (text) => text.replace(/ /g, " ").replace(/([\\*_`])/g, "\\$1");
// A line that would otherwise turn into a heading, list or quote keeps its first character literal.
const escapeLineStart = (line) => line.replace(/^(\s*)(#|>|[-+](?=\s)|\d+(?=[.)]\s))/, "$1\\$2");

function wrap(inner, marker) {
  const match = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : inner;
}

function inline(node) {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) { out += escapeText(child.textContent); return; }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const tag = child.tagName;
    if (tag === "BR") { out += "\n"; return; }
    if (tag === "UL" || tag === "OL") return; // nested lists are handled by list()
    if (tag === "CODE") { out += `\`${child.textContent.replace(/`/g, "")}\``; return; }
    const style = child.style || {};
    const bold = tag === "B" || tag === "STRONG" || style.fontWeight === "bold" || Number(style.fontWeight) >= 600;
    const italic = tag === "I" || tag === "EM" || style.fontStyle === "italic";
    let inner = inline(child);
    if (italic) inner = wrap(inner, "*");
    if (bold) inner = wrap(inner, "**");
    out += BLOCK_TAGS.has(tag) ? ` ${inner} ` : inner;
  });
  return out;
}

function list(el, depth, lines) {
  let number = el.tagName === "OL" ? Number(el.getAttribute("start")) || 1 : 0;
  el.childNodes.forEach((child) => {
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    if (child.tagName === "UL" || child.tagName === "OL") { list(child, depth + 1, lines); return; }
    const text = inline(child).replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    const marker = number ? `${number++}. ` : "- ";
    if (text) lines.push(`${"  ".repeat(depth)}${marker}${text}`);
    child.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => list(nested, depth + 1, lines));
  });
}

function blocks(root, lines) {
  let loose = "";
  const flushLoose = () => {
    loose.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => lines.push(escapeLineStart(line)));
    loose = "";
  };
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) { loose += escapeText(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (!BLOCK_TAGS.has(tag)) {
      if (tag === "BR") loose += "\n";
      else loose += inline({ childNodes: [node] });
      return;
    }
    flushLoose();
    if (tag === "UL" || tag === "OL") { list(node, 0, lines); return; }
    if (tag === "HR") { lines.push("---"); return; }
    if (tag === "PRE") { lines.push("```", ...node.textContent.split("\n"), "```"); return; }
    if (tag === "BLOCKQUOTE") {
      const inner = [];
      blocks(node, inner);
      inner.forEach((line) => lines.push(`> ${line}`));
      return;
    }
    if ((tag === "DIV" || tag === "P" || tag === "LI") && [...node.children].some((child) => BLOCK_TAGS.has(child.tagName))) {
      blocks(node, lines);
      return;
    }
    const text = inline(node).split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!text.length) return;
    if (/^H[1-6]$/.test(tag)) {
      if (lines.length) lines.push("");
      lines.push(`${tag === "H1" || tag === "H2" ? "##" : "###"} ${text.join(" ")}`);
      return;
    }
    text.forEach((line) => lines.push(escapeLineStart(line)));
  });
  flushLoose();
}

export function toMarkdown(element) {
  const lines = [];
  blocks(element, lines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Markdown -> an HTML string built from the safe DOM above (for pasting into the editor).
export function markdownToHtml(source) {
  const holder = document.createElement("div");
  holder.append(renderMarkdown(source));
  return holder.innerHTML;
}
