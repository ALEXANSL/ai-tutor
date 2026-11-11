/* global chrome */
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://diary.eschool-ua.com/")) { document.getElementById("message").textContent = "Спочатку відкрий вкладку diary.eschool-ua.com і ввійди. Потім натисни іконку помічника ще раз."; return; }
  await chrome.tabs.create({ url: `${chrome.runtime.getURL("sync.html")}?tab=${tab.id}` }); window.close();
})().catch(() => { document.getElementById("message").textContent = "Не вдалося відкрити помічник. Онови вкладку щоденника й повтори."; });
