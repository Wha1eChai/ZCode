import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";

export type HttpResponse = ServerResponse<IncomingMessage>;

export function json(response: HttpResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
}

export async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("Request body exceeds 16 KiB.");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON body must be an object.");
  return value;
}

export async function assertBuiltClientDirectory(directory: string): Promise<void> {
  try {
    await access(join(directory, "index.html"), constants.R_OK);
  } catch {
    throw new Error("Pi UI build not found; run `pnpm --dir packages/pi-ui build` first.");
  }
}

export function setSecureHeaders(response: HttpResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("cache-control", "no-store");
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function scopedAssetReferences(content: string, token: string): string {
  return content.replace(/(["'(=])\/assets\//gu, `$1/${token}/assets/`);
}

export async function serveStaticAsset(
  response: HttpResponse,
  staticRoot: string,
  route: string,
  token: string,
): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(route === "" ? "index.html" : route);
  } catch {
    json(response, 404, { error: "Not found." });
    return;
  }
  if (
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    json(response, 404, { error: "Not found." });
    return;
  }
  const filePath = resolve(staticRoot, decodedPath);
  if (!filePath.startsWith(`${staticRoot}${sep}`) && filePath !== staticRoot) {
    json(response, 404, { error: "Not found." });
    return;
  }
  try {
    const target = await realpath(filePath);
    if (!target.startsWith(`${staticRoot}${sep}`) && target !== staticRoot)
      throw new Error("outside root");
    let content = await readFile(target);
    if ([".html", ".css", ".js", ".mjs"].includes(extname(target).toLowerCase())) {
      content = Buffer.from(scopedAssetReferences(content.toString("utf8"), token));
    }
    response.writeHead(200, {
      "content-type": mediaType(target),
      "content-length": content.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(content);
  } catch {
    json(response, 404, { error: "Not found." });
  }
}
