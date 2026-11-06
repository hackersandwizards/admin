// admin takes brand and scaffolding from the repository that installs it (peerDependencies). A
// command checks the files it loads before importing them, so a missing or too old pin stops it
// with what to install instead of a module-resolution trace.
export function requirePeers(command: string, specs: string[]) {
  const missing = specs.filter((spec) => {
    try {
      Bun.resolveSync(spec, import.meta.dir);
      return false;
    } catch {
      return true;
    }
  });
  if (!missing.length) return;
  const names = [...new Set(missing.map((s) => s.split("/").slice(0, 2).join("/")))];
  console.error(
    `${command}: cannot load ${missing.join(", ")}. Pin ${names.join(" and ")} in this repository's package.json (admin's tested tags are in its devDependencies), then run bun install.`,
  );
  process.exit(1);
}
