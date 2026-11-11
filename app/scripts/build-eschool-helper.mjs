import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { collectEsSchool } from "../companion/eschool/collector.mjs";
import { runMobileHelper } from "../companion/eschool/mobile.mjs";
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = join(appRoot, "companion/eschool"); const files = {};
for (const name of await readdir(directory)) if (!name.endsWith(".d.mts")) files[name] = new Uint8Array(await readFile(join(directory, name)));
await writeFile(join(appRoot, "public/eschool-helper.zip"), zipSync(files));

const bookmarklet = `javascript:void((${runMobileHelper.toString()})(${collectEsSchool.toString()}))`;
const encoded = `javascript:${encodeURIComponent(bookmarklet.slice("javascript:".length))}`;
if (encoded.length > 60000) throw new Error("Mobile helper bookmark URL is too long");
await writeFile(join(appRoot, "public/eschool-mobile-bookmark.txt"), encoded);
