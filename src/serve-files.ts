import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { gitAsync, gitBytes } from "./git.ts";

// Specimen pages link brand's stylesheets under node_modules, which no commit holds, so the
// installed file answers, only from inside the repository, since a symlink there may point
// anywhere on disk.
export function readInstalledFile(repo: string, path: string): Buffer | undefined {
  const installed = join(repo, path);
  if (!existsSync(installed) || !statSync(installed).isFile()) return undefined;
  return realpathSync(installed).startsWith(realpathSync(repo) + sep)
    ? readFileSync(installed)
    : undefined;
}

export function lfsPointerOid(blob: Buffer): string | undefined {
  return blob
    .subarray(0, 200)
    .toString()
    .match(/^version https:\/\/git-lfs\S+\noid sha256:([0-9a-f]{64})/)?.[1];
}

export async function readCommittedFile(repo: string, path: string): Promise<Buffer | undefined> {
  const blob = await gitBytes(repo, ["cat-file", "blob", `HEAD:${path}`]);
  if (!blob) return undefined;
  const oid = lfsPointerOid(blob);
  if (!oid) return blob;
  const common = resolve(repo, (await gitAsync(repo, ["rev-parse", "--git-common-dir"])).trim());
  const object = join(common, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  return existsSync(object) ? readFileSync(object) : undefined;
}

export async function readRepoFile(
  repo: string | undefined,
  path: string,
): Promise<Buffer | undefined> {
  if (!repo || path.split("/").includes("..")) return undefined;
  return path.startsWith("node_modules/")
    ? readInstalledFile(repo, path)
    : readCommittedFile(repo, path);
}

// Fits an image into `box`. An animated file, one that already fits, one the WebP would not shrink
// and one Bun cannot read answer as committed; only a file that is no image goes unlogged.
export async function resizeThumbnail(body: Buffer, [width, height]: readonly [number, number]) {
  try {
    const image = new Bun.Image(body, { maxPixels: 64_000_000 });
    const size = await image.metadata();
    const animated = size.format === "gif" || body.includes("acTL") || body.includes("ANIM");
    if (animated || (size.width <= width && size.height <= height)) return undefined;
    const small = await image
      .resize(width, height, { fit: "inside" })
      .webp({ quality: 80 })
      .buffer();
    return small.length < body.length ? small : undefined;
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_IMAGE_UNKNOWN_FORMAT")
      console.error("admin-serve: thumbnail:", e);
    return undefined;
  }
}

// Unchanged bytes keep their tag, so a repeat view skips the resize and the download.
export const fileEtag = (body: Buffer, box?: readonly [number, number]) =>
  `"${Bun.hash(body).toString(36)}${box ? `-${box[0]}` : ""}"`;
