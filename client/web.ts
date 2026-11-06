import { Platform } from "react-native";

// Web-only DOM helpers for pictures (avatars, team logos): file picking and picture scaling.
// Pickers are no-ops off the web.
// This plugin typechecks without the DOM library. Declare only what this module uses.

interface DomFile {
  name: string;
  type: string;
  size: number;
}
interface DomInput {
  type: string;
  multiple: boolean;
  accept: string;
  style: { display: string };
  files: ArrayLike<DomFile> | null;
  onchange: (() => void) | null;
  addEventListener(type: "cancel", listener: () => void): void;
  click(): void;
  remove(): void;
}
interface DomImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decode(): Promise<void>;
}
interface DomCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): { imageSmoothingQuality: string; drawImage(image: DomImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void } | null;
  toDataURL(type: string, quality: number): string;
}
declare const document: {
  createElement(tag: "input"): DomInput;
  createElement(tag: "img"): DomImage;
  createElement(tag: "canvas"): DomCanvas;
  body: { appendChild(node: unknown): void };
};
declare class FileReader {
  result: string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: DomFile): void;
}

const web = Platform.OS === "web";

/** A picked file whose size is known before its bytes are read. */
export interface FileHandle {
  name: string;
  mimeType: string;
  size: number;
  readBase64(): Promise<string>;
}

/** Native has no file picker available to plugins; web uses a hidden file input. */
export const canPickFiles = web;

function readBase64(file: DomFile): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function toHandle(file: DomFile): FileHandle {
  return { name: file.name || "file", mimeType: file.type || "application/octet-stream", size: file.size, readBase64: () => readBase64(file) };
}

/** Opens the browser's file picker. Resolves with lazy handles so sizes can be checked before reading. */
export function pickFileHandles(options: { accept?: string; multiple?: boolean } = {}): Promise<FileHandle[]> {
  if (!web) return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? true;
    if (options.accept) input.accept = options.accept;
    input.style.display = "none";
    let done = false;
    const finish = (files: FileHandle[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish(Array.from(input.files ?? []).map(toHandle));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** A picture as a small square WebP data URL: its centre, scaled down to `size` pixels (avatars). */
export async function squareImage(source: string, size: number): Promise<string> {
  const image = document.createElement("img");
  image.src = source;
  await image.decode();
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!side || !context) throw new Error("That picture couldn't be read.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/webp", 0.85);
}
