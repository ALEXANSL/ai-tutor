/* global chrome */
import { collectEsSchool } from "./collector.mjs";
const APP = "https://ai-tutor-8zmb.vercel.app/parent/school";
const form = document.getElementById("form"), start = document.getElementById("start"), end = document.getElementById("end"), status = document.getElementById("status"), submit = document.getElementById("submit");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kiev", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const monday = new Date(`${today}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7); start.value = monday.toISOString().slice(0, 10); monday.setUTCDate(monday.getUTCDate() + 6); end.value = monday.toISOString().slice(0, 10);
let packet = null;
form.addEventListener("submit", async event => {
  event.preventDefault(); if (submit.disabled) return; submit.disabled = true; document.getElementById("result").hidden = true;
  status.textContent = "Читаємо теми й ДЗ. Можна залишатися на цій вкладці…"; const spinner = document.createElement("span"); spinner.className = "spinner"; status.prepend(spinner);
  try {
    const tabId = Number(new URL(location.href).searchParams.get("tab")); if (!Number.isInteger(tabId) || tabId < 1) throw Error("Відкрий щоденник і запусти помічник його іконкою у браузері.");
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: collectEsSchool, args: [start.value, end.value] });
    if (result?.result?.error) throw Error(result.result.error);
    if (!result?.result || result.result.schemaVersion !== 1) throw Error(result?.error?.message || "ESCHOOL-READ: не вдалося прочитати дані. Перевір вхід у щоденник.");
    packet = result.result; if (JSON.stringify(packet).length > 1500000) throw Error("Пакет завеликий. Обери коротший діапазон дат.");
    await chrome.storage.session.set({ eschoolPacket: { packet, expiresAt: Date.now() + 15 * 60 * 1000 } });
    status.textContent = `Прочитано ${packet.entries.filter(item => item.kind === "lesson").length} уроків і ${packet.entries.filter(item => item.kind === "homework").length} ДЗ. ${packet.warnings.length ? "Є попередження — переглянь їх у репетиторі." : "Перевір дані перед імпортом."}`;
    document.getElementById("open").href = APP; document.getElementById("result").hidden = false;
    await chrome.tabs.create({ url: APP });
  } catch (error) { status.textContent = error?.message || "Не вдалося прочитати щоденник. Онови його вкладку й спробуй ще раз."; }
  finally { submit.disabled = false; }
});
document.getElementById("download").addEventListener("click", () => { if (!packet) return; const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `eschool-${packet.range.start}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); });
