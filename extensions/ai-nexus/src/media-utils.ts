export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isFileUrl(url: string): boolean {
  return /^file:\/\//i.test(url);
}

export function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}
