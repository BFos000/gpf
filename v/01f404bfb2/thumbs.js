// Car and helmet thumbnails in HTML tables (standings, market, drivers, race setup). The views write these
// placeholders; Sprites.paintThumbs(root) draws them once the sprite sheets (and the livery kit) are in.
const att = (v) => String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
/** the car side-on, with its driver's helmet (driver optional: a plain helmet) */
export const carThumb = (car, driver = null, w = 76, h = 24) => car
  ? `<canvas class="th th-car" data-thumb="car" data-car="${att(car)}" data-d="${att(driver ?? "")}" width="${w}" height="${h}" aria-hidden="true"></canvas>` : "";
/** the driver's helmet (their own art, else the era's helmet in their national colour) */
export const helmetThumb = (driver, year = "", size = 20) => driver == null ? ""
  : `<canvas class="th th-helm" data-thumb="helmet" data-d="${att(driver)}" data-y="${att(year)}" width="${size}" height="${Math.round(size * 0.9)}" aria-hidden="true"></canvas>`;
