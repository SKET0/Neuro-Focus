// A steady colour for each class (the same on Home and the Classes page), picked from its id.
export const CLASS_COLORS = ["#22d3ee", "#a78bfa", "#4ade80", "#fb923c", "#60a5fa", "#f472b6", "#facc15", "#2dd4bf"];
export const classColor = (id) => CLASS_COLORS[[...String(id)].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 997, 7) % CLASS_COLORS.length];
