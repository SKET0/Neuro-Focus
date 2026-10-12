// One colour per class, worked out from its id, so a class looks the same everywhere: the
// sidebar's class list (both dashboards) and the teacher Home's class switcher. Pages set it as
// the --hue CSS variable; .cs-badge (styles/home.css) paints it.
export const classHue = (id) => [...String(id)].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7);
