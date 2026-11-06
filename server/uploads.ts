import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Saves a file into the bot's folder (`home`) for its chat to read. */
export async function saveUpload(home: string, { fileName, dataBase64 }: { fileName: string; dataBase64: string }) {
  const safe = fileName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "") || "file";
  const dir = join(home, "uploads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now().toString(36)}-${safe}`);
  const bytes = Buffer.from(dataBase64, "base64");
  await writeFile(path, bytes);
  return { path, size: bytes.length };
}
