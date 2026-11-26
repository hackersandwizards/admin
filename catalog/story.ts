import { data } from "../site/src/data";

export const site = data();
export const page = (type: string) => {
  const found = site.pages.find((p) => p.type === type);
  if (found === undefined) throw new Error(`catalog page missing: ${type}`);
  return found;
};

const [firstRepo] = site.repos;
if (firstRepo === undefined) throw new Error("repository missing: catalog fixture");
export const repo = firstRepo;
export const items = repo.items;
export const item = (id: string) => {
  const found = items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`catalog item missing: ${id}`);
  return found;
};
