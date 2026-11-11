/* global chrome */
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let trusted = false;
  try { const url = new URL(sender.url || sender.tab?.url || ""); trusted = url.origin === "https://ai-tutor-8zmb.vercel.app" && url.pathname === "/parent/school"; } catch { /* Ignore other senders. */ }
  if (!trusted || !["eschool.read", "eschool.clear"].includes(message?.type)) return false;
  (async () => {
    const { eschoolPacket: value } = await chrome.storage.session.get("eschoolPacket");
    if (message.type === "eschool.clear") { if (value?.packet?.packetId === message.packetId) await chrome.storage.session.remove("eschoolPacket"); reply({ cleared: true }); return; }
    if (!value || value.expiresAt < Date.now()) { await chrome.storage.session.remove("eschoolPacket"); reply({ packet: null }); return; }
    reply({ packet: value.packet });
  })().catch(() => reply({ packet: null }));
  return true;
});
