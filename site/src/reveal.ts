import { decodeHash, goneItemNotice } from "./filter-rules.ts";

export interface TargetFilterHost {
  focusTarget(target: HTMLElement | null): void;
  apply(picked?: boolean): void;
}

export function openAncestors(target: HTMLElement | null): void {
  for (
    let el: HTMLElement | null = target;
    el;
    el = el.parentElement?.closest<HTMLElement>("details") ?? null
  )
    (el as HTMLDetailsElement).open = true;
}

export function setupReveal(doc: Document, filters: TargetFilterHost): () => void {
  const reveal = (): void => {
    const fragment = decodeHash(location.hash);
    const target = doc.getElementById(fragment);
    filters.focusTarget(target);
    filters.apply();
    openAncestors(target);
    target?.scrollIntoView();
    const gone = doc.getElementById("admin-gone");
    if (gone) {
      const notice = goneItemNotice(fragment, Boolean(target));
      gone.hidden = !notice;
      gone.textContent = notice;
    }
  };
  addEventListener("hashchange", reveal);
  return reveal;
}
