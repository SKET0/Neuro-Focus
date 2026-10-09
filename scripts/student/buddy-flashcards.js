// NeuroBuddy flashcards: make a deck from this chat, a file in it, or any topic, then practise it
// card by card (flip, "Again" / "Got it", shuffle, a summary at the end). Decks are saved with the
// chat (buddy-store.js). Practising works like a real deck: "Got it" takes a card out of the pile,
// "Again" puts it back a few cards later until it's known, and cards that needed "Again" are
// remembered (card.misses) so they come first next time. Cards come from the learning-assistant
// function's "flashcards" task; an
// older deployed function only has "quiz" (from given text, up to 10 cards), which is used instead.
import { streamAssistant } from "../services/assistant-api.js?v=2";
import { markdownToPlain } from "../shared/markdown.js?v=1";

const COUNTS = [5, 10, 15, 20];
const SOURCE_CHARS = 60000;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function svgIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}
function button(label, className, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function parseCards(text) {
  const cards = [];
  const pattern = /Q:\s*([\s\S]*?)\n\s*A:\s*([\s\S]*?)(?=\n\s*Q:|$)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const question = markdownToPlain(match[1]).trim();
    const answer = markdownToPlain(match[2]).trim();
    if (question && answer) cards.push({ question, answer });
  }
  return cards;
}

// The chat as plain text, for cards "from this chat".
export function chatText(chat) {
  return chat.messages.map((message) => `${message.role === "user" ? "Student" : "NeuroBuddy"}: ${message.content}`).join("\n\n");
}

const AGAIN_GAP = 3; // an "Again" card comes back after this many other cards

export function createFlashcards({ supabase, onSaveDeck, onUpdateDeck }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#flashDialog");
  const content = $("#flashContent");
  const title = $("#flashTitle");
  const sub = $("#flashSub");
  const shuffleButton = $("#flashShuffle");
  let controller = null;
  let reshuffle = null; // set while practising
  let chat = null;

  dialog.addEventListener("close", () => { controller?.abort(); controller = null; reshuffle = null; shuffleButton.hidden = true; });
  shuffleButton.addEventListener("click", () => reshuffle?.());
  $("#flashClose").addEventListener("click", () => dialog.close());
  // While practising: Space or Enter shows the answer (the card is a button), 1 = Again, 2 = Got it.
  dialog.addEventListener("keydown", (event) => {
    const practice = content.querySelector(".flash-practice");
    if (!practice || event.target.closest("input, select, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
    const action = { 1: "again", 2: "known" }[event.key];
    if (action) { event.preventDefault(); practice.dispatchEvent(new CustomEvent(action)); }
  });

  // ---------- Make a deck ----------
  function openMaker(currentChat, { topic = "" } = {}) {
    chat = currentChat;
    reshuffle = null;
    shuffleButton.hidden = true;
    title.textContent = "Make flashcards";
    sub.textContent = "Practise what you’re learning, one card at a time.";
    const form = el("form", "flash-maker");
    form.noValidate = true;

    const sources = el("fieldset", "flash-sources");
    sources.append(el("legend", "field-label", "Make cards from"));
    const options = [];
    const hasChat = chat.messages.some((message) => message.role === "assistant");
    if (hasChat) options.push({ value: "chat", label: "This chat", note: `${chat.messages.length} messages` });
    chat.documents.forEach((doc) => options.push({ value: `doc:${doc.id}`, label: doc.name, note: "File in this chat" }));
    options.push({ value: "topic", label: "A topic", note: "Any subject you’re studying" });
    options.forEach((option, index) => {
      const label = el("label", "flash-source");
      const input = el("input");
      input.type = "radio";
      input.name = "flashSource";
      input.value = option.value;
      input.checked = topic ? option.value === "topic" : index === 0;
      const text = el("span");
      text.append(el("b", "", option.label), el("small", "", option.note));
      label.append(input, text);
      sources.append(label);
    });

    const topicWrap = el("div", "flash-topic");
    const topicLabel = el("label", "field-label", "Topic");
    topicLabel.htmlFor = "flashTopic";
    const topicInput = el("input", "field-input");
    topicInput.id = "flashTopic";
    topicInput.maxLength = 300;
    topicInput.placeholder = "e.g. Photosynthesis, the causes of World War I, Spanish verbs";
    topicInput.value = topic;
    const focusHelp = el("small", "field-help", "With a chat or file, this narrows the cards to one part of it (optional).");
    focusHelp.id = "flashTopicHelp";
    topicInput.setAttribute("aria-describedby", "flashTopicHelp");
    topicWrap.append(topicLabel, topicInput, focusHelp);

    const countSet = el("fieldset", "flash-count");
    countSet.append(el("legend", "field-label", "How many cards"));
    const countRow = el("div", "range-switch");
    countRow.setAttribute("role", "radiogroup");
    let count = 10;
    COUNTS.forEach((value) => {
      const choice = button(String(value), "", () => {
        count = value;
        countRow.querySelectorAll("button").forEach((node) => node.setAttribute("aria-checked", String(Number(node.textContent) === count)));
      });
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", String(value === count));
      countRow.append(choice);
    });
    countSet.append(countRow);

    const message = el("p", "form-message");
    message.setAttribute("role", "status");
    const actions = el("div", "flash-actions");
    const make = el("button", "btn-primary", "Make flashcards");
    make.type = "submit";
    actions.append(button("Cancel", "btn-action", () => dialog.close()), make);

    const source = () => form.querySelector("input[name=flashSource]:checked")?.value || "topic";
    const syncTopic = () => {
      const isTopic = source() === "topic";
      topicLabel.textContent = isTopic ? "Topic" : "Focus on (optional)";
      focusHelp.hidden = isTopic;
      topicInput.required = isTopic;
    };
    sources.addEventListener("change", syncTopic);
    syncTopic();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const picked = source();
      const focus = topicInput.value.trim();
      if (picked === "topic" && focus.length < 2) {
        message.textContent = "Type a topic first.";
        message.dataset.state = "error";
        topicInput.focus();
        return;
      }
      const doc = picked.startsWith("doc:") ? chat.documents.find((entry) => `doc:${entry.id}` === picked) : null;
      const material = picked === "chat" ? chatText(chat) : doc ? doc.text : "";
      const deckTitle = picked === "topic" ? focus : doc ? doc.name : focus ? `${focus} (this chat)` : chat.title;
      void generate({ material, focus, count, deckTitle });
    });

    form.append(sources, topicWrap, countSet, message, actions);
    content.replaceChildren(form);
    if (!dialog.open) dialog.showModal();
    (topic ? topicInput : form.querySelector("input[name=flashSource]:checked"))?.focus();
  }

  async function generate({ material, focus, count, deckTitle }) {
    title.textContent = "Making flashcards…";
    sub.textContent = deckTitle;
    const loading = el("div", "flash-loading");
    const status = el("span", "", "NeuroBuddy is writing your cards…");
    status.setAttribute("role", "status");
    loading.append(el("span", "writing-dot"), status);
    content.replaceChildren(loading, Object.assign(el("div", "flash-actions"), {}));
    content.lastChild.append(button("Cancel", "btn-action", () => dialog.close()));
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    let target = count;
    const progress = (soFar) => {
      const ready = Math.max(0, parseCards(soFar).length - 1);
      status.textContent = ready ? `Writing cards… ${Math.min(ready, target)} of ${target} ready` : "NeuroBuddy is writing your cards…";
    };
    const classPart = chat.classId ? { classId: chat.classId } : {};
    try {
      let text;
      try {
        text = await streamAssistant(supabase, { task: "flashcards", ...classPart, source: material.slice(0, SOURCE_CHARS), topic: focus, count }, progress, { signal: mine.signal });
      } catch (error) {
        // An older NeuroBuddy function: make cards from the text with its "quiz" task instead.
        if (!/unknown assistant task/i.test(error?.message || "")) throw error;
        if (!material) throw new Error("Flashcards about any topic need the updated NeuroBuddy function (see README). You can still make cards from this chat or a file.");
        target = Math.min(count, 10);
        text = await streamAssistant(supabase, { task: "quiz", ...classPart, noteText: `${focus ? `Focus: ${focus}\n\n` : ""}${material}`.slice(0, 20000), count: target }, progress, { signal: mine.signal });
      }
      const cards = parseCards(text).slice(0, count);
      if (!cards.length) throw new Error("NeuroBuddy couldn’t make cards from that. Try a different topic or source.");
      if (controller !== mine) return;
      const deck = { id: crypto.randomUUID?.() || String(Date.now()), title: deckTitle || "Flashcards", createdAt: new Date().toISOString(), cards };
      onSaveDeck?.(chat.id, deck);
      practise(deck);
    } catch (error) {
      if (error?.name === "AbortError" || controller !== mine) return;
      title.textContent = "Flashcards";
      const actions = el("div", "flash-actions");
      actions.append(button("Close", "btn-action", () => dialog.close()), button("Try again", "btn-primary", () => openMaker(chat, { topic: focus })));
      const problem = el("p", "form-message", error instanceof Error ? error.message : "Couldn’t make flashcards. Try again.");
      problem.dataset.state = "error";
      problem.setAttribute("role", "alert");
      content.replaceChildren(problem, actions);
    }
  }

  // ---------- Practise ----------
  // A pile of cards: "Got it" removes the top card; "Again" slips it back a few places, so it comes
  // round again soon. The session ends when every card in it is known. (Keys, not shown on screen:
  // Space or Enter flips the card, 1 = Again, 2 = Got it.)
  function practise(deck, { onlyCards = null, shuffled = false } = {}) {
    if (!dialog.open) dialog.showModal();
    const cards = [...(onlyCards || deck.cards)];
    if (shuffled) cards.sort(() => Math.random() - 0.5);
    else if (!onlyCards && cards.some((card) => card.misses)) cards.sort((a, b) => (b.misses || 0) - (a.misses || 0)); // tricky ones first
    let pile = [...cards];
    const known = new Set();
    const missedNow = new Map(); // card -> times "Again" this session
    let flipped = false;
    title.textContent = deck.title;
    sub.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"}${onlyCards ? " to review" : ""}`;
    reshuffle = () => practise(deck, { onlyCards, shuffled: true });
    shuffleButton.hidden = false;

    const wrap = el("div", "flash-practice");
    const progress = el("div", "flash-progress");
    const bar = el("div", "flash-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Cards learned");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(cards.length));
    const fill = el("span");
    bar.append(fill);
    const count = el("span", "flash-tally");
    progress.append(bar, count);

    const card = el("button", "flash-card");
    card.type = "button";
    const inner = el("span", "flash-card-inner");
    const front = el("span", "flash-face flash-front");
    const back = el("span", "flash-face flash-back");
    inner.append(front, back);
    card.append(inner);

    const controls = el("div", "flash-controls");
    const show = button("Show answer", "btn-primary flash-show", () => flip(true));
    const againButton = button("", "flash-choice flash-again", () => mark("again"));
    againButton.append(svgIcon("i-again"), el("span", "", "Again"));
    againButton.title = "Again (1)";
    const knownButton = button("", "flash-choice flash-known", () => mark("known"));
    knownButton.append(svgIcon("i-check"), el("span", "", "Got it"));
    knownButton.title = "Got it (2)";
    controls.append(show, againButton, knownButton);
    const live = el("p", "sr-only");
    live.setAttribute("aria-live", "polite");
    wrap.append(progress, card, controls, live);
    wrap.addEventListener("again", () => { if (flipped) mark("again"); else flip(true); });
    wrap.addEventListener("known", () => { if (flipped) mark("known"); else flip(true); });
    card.addEventListener("click", () => flip(!flipped));
    content.replaceChildren(wrap);

    const sentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);
    function paint() {
      const top = pile[0];
      count.textContent = `${known.size} / ${cards.length}`;
      count.setAttribute("aria-label", `${known.size} of ${cards.length} learned`);
      bar.setAttribute("aria-valuenow", String(known.size));
      fill.style.width = `${(known.size / cards.length) * 100}%`;
      const repeat = missedNow.has(top);
      front.replaceChildren(...(repeat ? [el("span", "flash-tag", "Review")] : []), el("b", "", top.question));
      back.replaceChildren(el("b", "", top.answer));
      card.dataset.flipped = String(flipped);
      card.setAttribute("aria-label", flipped ? `Answer: ${sentence(top.answer)}` : `Question: ${sentence(top.question)} Press to show the answer.`);
      show.hidden = flipped;
      againButton.hidden = knownButton.hidden = !flipped;
    }
    function flip(value) {
      flipped = value;
      paint();
      card.focus();
    }
    function mark(result) {
      const top = pile.shift();
      if (result === "known") known.add(top);
      else {
        missedNow.set(top, (missedNow.get(top) || 0) + 1);
        pile.splice(Math.min(AGAIN_GAP, pile.length), 0, top);
      }
      live.textContent = result === "known" ? "Learned." : "This card will come back.";
      card.classList.remove("is-known", "is-again");
      void card.offsetWidth;
      card.classList.add(result === "known" ? "is-known" : "is-again");
      if (!pile.length) { finish(); return; }
      flipped = false;
      paint();
      card.focus();
    }
    function finish() {
      // Remember which cards were tricky (they come first next time); ones known first time count less.
      cards.forEach((entry) => { entry.misses = Math.max(0, (entry.misses || 0) + (missedNow.get(entry) || 0) - (missedNow.has(entry) ? 0 : 1)); });
      deck.lastPractised = new Date().toISOString();
      onUpdateDeck?.(deck);
      reshuffle = null;
      shuffleButton.hidden = true;
      const tricky = cards.filter((entry) => missedNow.has(entry));
      const firstTry = cards.length - tricky.length;
      const done = el("div", "flash-done");
      done.setAttribute("role", "status");
      const ring = el("div", "flash-ring");
      ring.style.setProperty("--score", String(firstTry / cards.length));
      ring.append(el("b", "", `${firstTry}/${cards.length}`));
      done.append(ring, el("h3", "", tricky.length ? "Deck complete" : "Perfect round"),
        el("p", "", tricky.length ? `${firstTry} known on the first try · ${tricky.length} to review` : "Every card known on the first try."));
      if (tricky.length) {
        const list = el("ul", "flash-tricky");
        tricky.forEach((entry) => {
          const item = el("li");
          item.append(el("b", "", entry.question), el("span", "", entry.answer));
          list.append(item);
        });
        done.append(list);
      }
      const actions = el("div", "flash-actions flash-actions-center");
      if (tricky.length) actions.append(button(`Review ${tricky.length} card${tricky.length === 1 ? "" : "s"}`, "btn-primary", () => practise(deck, { onlyCards: tricky, shuffled: true })));
      actions.append(button("Restart deck", tricky.length ? "btn-action" : "btn-primary", () => practise(deck, { shuffled: true })), button("Done", "btn-action", () => dialog.close()));
      fill.style.width = "100%";
      content.replaceChildren(done, actions);
      actions.querySelector("button")?.focus();
    }
    paint();
    card.focus();
  }

  return { openMaker, practise };
}
