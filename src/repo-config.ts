import { basename, join } from "node:path";
import { WORK_DIR } from "./items.ts";
import type { Source } from "./item-source.ts";
import { asKey, fileHref, REPO_KEY, SCHEME } from "./repo-paths.ts";

// No href: the configured one had a scheme other than http(s), so the label shows as text.
export type Link = { label: string; href?: string };
export type Product = { label: string; href?: string; description?: string };

type AdminConfig = {
  name?: string;
  label?: string;
  designSystem?: string;
  products?: Product[];
  links?: Link[];
};

type AstroCatalogConfig = { url: string; port: number; preset: boolean };
type AstroCatalogDev = { url: string; port: number; start?: string };

// What a repository whose package.json cannot carry admin, having none or another party owning it,
// sets there instead.
export const ADMIN_FILE = `${WORK_DIR}/admin.json`;
export const ASTRO_CONFIG = /^([^/]+\/)?astro\.config\.(ts|mjs|js)$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function parsePackageJson(text: string | undefined): {
  pkg: Record<string, unknown>;
  defects: string[];
} {
  if (text === undefined) return { pkg: {}, defects: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed)
      ? { pkg: parsed, defects: [] }
      : { pkg: {}, defects: ["package.json: not an object"] };
  } catch {
    return { pkg: {}, defects: ["package.json: not JSON"] };
  }
}

// A field of the wrong type is a defect, never a failed build of every repository's pages.
export function readPackageTextMap(
  pkg: Record<string, unknown>,
  field: string,
): { value: Record<string, string>; defects: string[] } {
  const value = pkg[field] ?? {};
  const entries = isPlainObject(value) ? Object.entries(value) : [];
  const kept = entries.filter(([, v]) => typeof v === "string");
  const defects =
    !isPlainObject(value) || kept.length < entries.length
      ? [`package.json: ${field} holds a value that is not text`]
      : [];
  return { value: Object.fromEntries(kept) as Record<string, string>, defects };
}

export function readPackageBin(pkg: Record<string, unknown>): {
  value: Record<string, string>;
  defects: string[];
} {
  if (typeof pkg.bin === "string") return { value: { [String(pkg.name)]: pkg.bin }, defects: [] };
  return readPackageTextMap(pkg, "bin");
}

export function parseAdminFile(text: string | undefined): { value: unknown; defects: string[] } {
  if (text === undefined) return { value: undefined, defects: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed)
      ? { value: parsed, defects: [] }
      : { value: parsed, defects: [`${ADMIN_FILE}: not a JSON object`] };
  } catch {
    return { value: undefined, defects: [`${ADMIN_FILE}: not JSON`] };
  }
}

// package.json's admin, where it holds one, else docs/agent-work/admin.json's; `from` names the
// source in a defect.
export function parseAdminSource(
  pkgAdmin: unknown,
  ownText: string | undefined,
): { admin: AdminConfig; from: string; defects: string[] } {
  const own = parseAdminFile(ownText);
  const defects = [...own.defects];
  const hasPkgAdmin = pkgAdmin !== undefined;
  const [raw, from] = hasPkgAdmin
    ? [pkgAdmin, "package.json: admin."]
    : [own.value, `${ADMIN_FILE}: `];
  if (hasPkgAdmin && !isPlainObject(raw)) defects.push("package.json: admin is not an object");
  if (hasPkgAdmin && isPlainObject(own.value))
    defects.push(`${ADMIN_FILE}: ignored, package.json holds admin`);
  return { admin: (isPlainObject(raw) ? raw : {}) as AdminConfig, from, defects };
}

export function resolveRepoKey(
  repo: string,
  name: unknown,
  from: string,
): { key: string; defects: string[] } {
  const fallback = asKey(basename(repo));
  if (typeof name !== "string") return { key: fallback, defects: [] };
  if (REPO_KEY.test(name)) return { key: name, defects: [] };
  const defects =
    fallback !== name
      ? [
          `${from}name "${name}" is not letters, digits, ".", "_" and "-": its pages are under ${fallback}`,
        ]
      : [];
  return { key: fallback, defects };
}

export function resolveRepoLabel(
  rawLabel: unknown,
  from: string,
): { label?: string; defects: string[] } {
  if (rawLabel === undefined) return { label: undefined, defects: [] };
  if (typeof rawLabel !== "string")
    return { label: undefined, defects: [`${from}label is not text`] };
  return { label: rawLabel.trim() || undefined, defects: [] };
}

// Only http(s) links out, beside the pages' policy, which refuses a javascript: link too.
export function resolveAdminHref(
  repo: string,
  rawHref: string,
  fieldLabel: string,
): { href?: string; defect?: string } {
  if (/^https?:/i.test(rawHref)) return { href: rawHref };
  if (SCHEME.test(rawHref)) return { defect: `${fieldLabel}: scheme not allowed, not linked` };
  const [, path, rest] = rawHref.match(/^([^?#]*)(.*)$/s)!;
  return { href: fileHref(join(repo, path!)) + rest };
}

export function resolveDesignSystemHref(
  repo: string,
  configured: unknown,
  from: string,
): { href?: string; defects: string[] } {
  if (typeof configured !== "string") return { defects: [] };
  const resolved = resolveAdminHref(repo, configured, `${from}designSystem`);
  return { href: resolved.href, defects: resolved.defect ? [resolved.defect] : [] };
}

// Config entries without a text label and href are dropped rather than failing the whole hub.
export function resolveLinkedEntries<T extends { label?: unknown; href?: unknown }>(
  repo: string,
  list: T[] | undefined,
  fieldPrefix: string,
): {
  entries: (Omit<T, "label" | "href"> & { label: string; href?: string })[];
  defects: string[];
} {
  const valid = (Array.isArray(list) ? list : []).filter(
    (e): e is T & { label: string; href: string } =>
      typeof e?.label === "string" && typeof e?.href === "string",
  );
  const defects: string[] = [];
  const entries = valid.map((entry) => {
    const resolved = resolveAdminHref(repo, entry.href, `${fieldPrefix} "${entry.label}"`);
    if (resolved.defect) defects.push(resolved.defect);
    return { ...entry, href: resolved.href };
  });
  return { entries, defects };
}

const configString = (text: string, key: string) =>
  text.match(new RegExp(`\\b${key}:\\s*["']([^"']+)["']`))?.[1];

export function parseAstroCatalogConfig(text: string): AstroCatalogConfig | undefined {
  const preset = text.includes("@hackersandwizards/scaffolding/catalog");
  if (!preset && !text.includes("astrobook")) return undefined;
  const port = text.match(/\bport:\s*(\d+)/)?.[1];
  if (!port) return undefined;
  // The preset answers /catalog/ wherever its catalog sits, forwarding a home catalog to its
  // root; dev drops the base.
  const path = preset
    ? "/catalog/"
    : `${configString(text, "base") ?? ""}${configString(text, "subpath") ?? ""}`.replace(
        /\/*$/,
        "/",
      );
  return { url: `http://127.0.0.1:${port}${path}`, port: Number(port), preset };
}

export function pickCatalogStartScript(
  scripts: Record<string, string>,
  configDir: string,
): string | undefined {
  const runs = Object.keys(scripts).filter((k) => {
    const v = scripts[k]!;
    return v.includes("astro dev") && (configDir ? v.includes(configDir) : !/--root|\bcd /.test(v));
  });
  return runs.find((k) => k.includes("design")) ?? runs.find((k) => k === "dev") ?? runs[0];
}

export function findAstrobookDev(
  src: Source,
  scripts: Record<string, string>,
): AstroCatalogDev | undefined {
  for (const p of src.paths) {
    if (!ASTRO_CONFIG.test(p)) continue;
    const catalog = parseAstroCatalogConfig(src.read(p) ?? "");
    if (!catalog) continue;
    const dir = p.includes("/") ? p.slice(0, p.indexOf("/")) : "";
    const start =
      catalog.preset && scripts.catalog ? "catalog" : pickCatalogStartScript(scripts, dir);
    return { url: catalog.url, port: catalog.port, start };
  }
}

export function selectDesignSystem(
  configuredHref: string | undefined,
  dev: AstroCatalogDev | undefined,
): { designSystem?: string; designSystemDev?: { port: number; start?: string } } {
  const designSystem = configuredHref || dev?.url;
  const designSystemDev =
    dev && designSystem === dev.url ? { port: dev.port, start: dev.start } : undefined;
  return { designSystem, designSystemDev };
}

export function readCheckSteps(scripts: Record<string, string>): string[] {
  const check = scripts["check:all"] ?? scripts.check ?? "";
  return check
    .split(/\s*&&\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readRepoConfig(repo: string, src: Source) {
  const { pkg, defects: pkgDefects } = parsePackageJson(src.read("package.json"));
  const { admin, from, defects: adminDefects } = parseAdminSource(pkg.admin, src.read(ADMIN_FILE));
  const key = resolveRepoKey(repo, admin.name, from);
  const label = resolveRepoLabel(admin.label, from);
  const scripts = readPackageTextMap(pkg, "scripts");
  const deps = readPackageTextMap(pkg, "dependencies");
  const devDeps = readPackageTextMap(pkg, "devDependencies");
  const dev = findAstrobookDev(src, scripts.value);
  const dsHref = resolveDesignSystemHref(repo, admin.designSystem, from);
  const { designSystem, designSystemDev } = selectDesignSystem(dsHref.href, dev);
  return {
    pkg,
    pkgFields: {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      dependencies: { ...deps.value, ...devDeps.value },
      scripts: scripts.value,
    },
    admin,
    from,
    key: key.key,
    label: label.label,
    scripts: scripts.value,
    designSystem,
    designSystemDev,
    defects: [
      ...pkgDefects,
      ...adminDefects,
      ...key.defects,
      ...label.defects,
      ...scripts.defects,
      ...deps.defects,
      ...devDeps.defects,
      ...dsHref.defects,
    ],
  };
}
