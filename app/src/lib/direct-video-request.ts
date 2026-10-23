/** Let the browser manage cross-origin video byte ranges itself. The app
 * service worker caches only its static shell, never private media. */
export function isDirectVideoRequest(request: Pick<Request, "destination" | "headers">, url: URL): boolean {
  return request.destination === "video" || request.headers.has("range") || url.pathname.startsWith("/storage/v1/object/sign/video_lessons/");
}
