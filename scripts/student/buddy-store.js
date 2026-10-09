// NeuroBuddy chats, saved on this device per account (localStorage), like the single chat before.
// Each chat: { id, title, classId, createdAt, updatedAt, messages, documents, decks }.
//   messages:  [{ role: "user" | "assistant", content, files?: [{ name, kind }] }]
//   documents: text read from files the student added ({ id, name, kind, text, truncated }),
//              kept with the chat so follow-up questions can use them
//   decks:     flashcard sets ({ id, title, createdAt, cards: [{ question, answer }] })
// Pictures are sent with the message they belong to and aren't kept (only their names are).
// The first time, the old one-chat-per-class history (neuroFocusChat:<user>:<class>) becomes chats.

const VERSION = 1;
export const LIMITS = { chats: 60, messages: 80, documents: 5, documentChars: 30000, decks: 12 };

const storeKey = (userId) => `neuroFocusBuddyChats:${userId}`;
const oldPrefix = (userId) => `neuroFocusChat:${userId}:`;
export const newId = () => (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

function migrate(userId) {
  const chats = [];
  try {
    Object.keys(localStorage).filter((key) => key.startsWith(oldPrefix(userId))).forEach((key) => {
      let history = [];
      try { history = JSON.parse(localStorage.getItem(key) || "[]"); } catch { history = []; }
      const messages = (Array.isArray(history) ? history : [])
        .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
        .map((entry) => ({ role: entry.role, content: entry.content }));
      if (!messages.length) return;
      const classKey = key.slice(oldPrefix(userId).length);
      const now = new Date().toISOString();
      chats.push({ id: newId(), title: titleFrom(messages.find((entry) => entry.role === "user")?.content), classId: classKey === "open-tutor" ? "" : classKey,
        createdAt: now, updatedAt: now, messages, documents: [], decks: [] });
    });
  } catch { /* storage unavailable */ }
  return chats;
}

export function loadChats(userId) {
  try {
    const stored = JSON.parse(localStorage.getItem(storeKey(userId)) || "null");
    if (stored?.version === VERSION && Array.isArray(stored.chats)) return stored.chats;
  } catch { /* unreadable: start again */ }
  const chats = migrate(userId);
  saveChats(userId, chats);
  return chats;
}

// Returns "" when saved, or a message when this device's storage is full.
export function saveChats(userId, chats) {
  const sorted = [...chats].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, LIMITS.chats);
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify({ version: VERSION, chats: sorted }));
    return "";
  } catch {
    return "This device’s storage is full, so the latest change couldn’t be saved. Delete an old chat or a file to make room.";
  }
}

export function titleFrom(text = "") {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 48 ? `${clean.slice(0, 46).trimEnd()}…` : clean;
}

// The most recent chat with a question in it (Home's "Continue where you left off").
export function latestChat(userId) {
  const chats = loadChats(userId).filter((chat) => chat.messages.some((message) => message.role === "user"));
  chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const chat = chats[0];
  if (!chat) return null;
  const question = [...chat.messages].reverse().find((message) => message.role === "user")?.content || "";
  return { id: chat.id, title: chat.title, classId: chat.classId, question, updatedAt: chat.updatedAt };
}
