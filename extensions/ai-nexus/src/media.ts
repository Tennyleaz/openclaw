// oxlint-disable no-unused-vars
import { constants as FS } from "node:fs";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { extname, isAbsolute, resolve, join, normalize } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { DeliverEvent, MediaCollector, MediaItem } from "./types.js";
import { isFileUrl, isHttpUrl } from "./media-utils.js";

export const activeMediaCollectors = new Map<string, MediaCollector>();

/** Only allow loadable image files to be converted to base64 data-URLs. */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

async function existsFile(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * If `url` is a local path, read it and return a base64 data-URL with the
 * appropriate MIME type. Remote URLs (http/https) are returned unchanged.
 */
export async function resolveMediaItem(
  url: string,
  mediaLocalRoots: readonly string[] = [],
): Promise<MediaItem> {
  // http(s) paths
  if (isHttpUrl(url)) {
    return { url };
  }

  // Decide what filesystem path to try
  let candidatePaths: string[] = [];

  // file:// paths
  if (isFileUrl(url)) {
    try {
      candidatePaths = [fileURLToPath(url)];
    } catch {
      return { url }; // invalid file URL
    }
  } else {
    // 3) plain path
    const p = normalize(url);

    if (isAbsolute(p)) {
      candidatePaths = [p];
    } else {
      // relative: search in roots
      candidatePaths = mediaLocalRoots.map((root) => resolve(root, p));
    }
  }

  // Try each candidate until one reads
  for (const path of candidatePaths) {
    try {
      if (!(await existsFile(path))) {
        continue;
      }

      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      const contentType = MIME_BY_EXT[ext];

      if (!contentType) {
        // If unknown type, return a file:// URL (or keep original)
        return { url: pathToFileURL(path).toString() };
      }

      const dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;
      return { url: path, dataUrl: dataUrl, contentType };
    } catch {
      // try next candidate
    }
  }

  // Nothing found/readable
  return { url };
}
