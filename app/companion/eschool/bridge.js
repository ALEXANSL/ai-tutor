/* global chrome */
window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== "https://ai-tutor-8zmb.vercel.app" || location.pathname !== "/parent/school") return;
  const data = event.data;
  if (!data || !["AI_TUTOR_ESCHOOL_READ", "AI_TUTOR_ESCHOOL_CLEAR"].includes(data.type) || typeof data.nonce !== "string" || !/^[a-f0-9-]{36}$/i.test(data.nonce)) return;
  chrome.runtime.sendMessage({ type: data.type === "AI_TUTOR_ESCHOOL_READ" ? "eschool.read" : "eschool.clear", packetId: data.packetId }, response => {
    if (chrome.runtime.lastError) return;
    window.postMessage({ type: "AI_TUTOR_ESCHOOL_RESULT", nonce: data.nonce, packet: response?.packet ?? null }, "https://ai-tutor-8zmb.vercel.app");
  });
});
