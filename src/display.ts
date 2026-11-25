// A moment as a reader names it, "10 Nov, 09:05", in the machine's time zone.
export const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// What admin-serve resizes a committed image to: a review tile's 16:9 box (the page's aspect-video),
// and twice it for a 2x screen.
export const THUMB_BOXES = [
  [480, 270],
  [960, 540],
] as const;

// The attributes of an <img> showing the linked file smaller; the browser picks from the laid-out width.
export const thumbnail = (href: string) => ({
  src: `${href}?w=${THUMB_BOXES[0][0]}`,
  srcset: THUMB_BOXES.map(([w]) => `${href}?w=${w} ${w}w`).join(", "),
  sizes: "auto, 50vw",
});
