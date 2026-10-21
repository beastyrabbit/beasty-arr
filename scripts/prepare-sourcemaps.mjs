import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const artifacts = "dist/sourcemaps";
const sourceMapReference = /\n\/\/# sourceMappingURL=.*$/m;
rmSync(artifacts, { recursive: true, force: true });
for (const runtime of ["web", "server"]) {
  const root = `dist/${runtime}`;
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (file.endsWith(".js") || file.endsWith(".map")) {
        if (runtime === "web" && file.endsWith(".js")) {
          const map = JSON.parse(readFileSync(`${file}.map`, "utf8"));
          if (
            !map.debug_id ||
            !readFileSync(file, "utf8").includes(`//# debugId=${map.debug_id}`)
          ) {
            throw new Error(`Missing or mismatched browser debug ID: ${file}`);
          }
        }
        if (runtime === "web") {
          const target = path.join(artifacts, runtime, path.relative(root, file));
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(file, target);
        }
      }
    }
  }
  collect(root);
  function removeMaps(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) removeMaps(file);
      else if (file.endsWith(".js.map")) {
        if (runtime === "server") {
          // Node can map server stacks without shipping separate .map files.
          const js = file.slice(0, -4);
          const source = readFileSync(js, "utf8").replace(sourceMapReference, "");
          const inline = readFileSync(file).toString("base64");
          writeFileSync(
            js,
            `${source}\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
          );
        }
        rmSync(file);
      }
    }
  }
  removeMaps(root);
}
