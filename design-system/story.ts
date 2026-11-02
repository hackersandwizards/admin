// What the stories render: the fixture's data as the admin pages see it.
import { data } from "../site/src/data";

export const site = data();
export const page = (type: string) => site.pages.find((p) => p.type === type)!;
export const items = site.repos[0]!.items;
export const item = (id: string) => items.find((i) => i.id === id)!;
