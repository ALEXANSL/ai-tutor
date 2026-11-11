/** Self-contained bookmarklet UI. No remote scripts or credentials. */
export function runMobileHelper(collect) {
  if (location.origin !== "https://diary.eschool-ua.com") { alert("Спочатку відкрий diary.eschool-ua.com і ввійди. Запускай закладку на сторінці щоденника."); return; }
  const old = document.getElementById("ai-tutor-eschool-mobile"); if (old) { old.scrollIntoView(); return; }
  const host = document.createElement("div"); host.id = "ai-tutor-eschool-mobile"; host.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(12,20,36,.65);overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:center";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>*{box-sizing:border-box}section{max-width:530px;width:100%;margin:12px auto;padding:22px;border-radius:20px;background:#fff;color:#17243d;font:16px/1.5 system-ui,sans-serif}h1{font-size:23px;line-height:1.3;margin:0 0 12px}p{margin:10px 0}.muted{font-size:13px;color:#52617b}.dates{display:flex;gap:12px;flex-wrap:wrap}label{flex:1;font-size:14px;font-weight:700}input{display:block;min-height:46px;max-width:100%;width:100%;margin-top:5px;border:1px solid #bdc9dc;border-radius:10px;padding:8px;font:inherit}button,a{display:block;width:100%;min-height:48px;border:0;border-radius:12px;padding:12px;margin:10px 0;font:700 15px/1.5 system-ui;background:#3268dc;color:white;cursor:pointer;text-align:center;text-decoration:none}button:disabled{opacity:.55}button.secondary{background:#eaf0fa;color:#17243d}textarea{width:100%;min-height:110px;border:1px solid #bdc9dc;border-radius:10px;padding:8px;font-size:12px}#close{float:right;width:44px;margin:0 0 8px 8px;padding:8px;background:#edf2fa;color:#17243d}#status{white-space:pre-wrap;font-weight:600}#data[hidden],#output[hidden]{display:none}</style><section role="dialog" aria-label="Помічник Єдиної школи"><button id="close" aria-label="Закрити">×</button><h1>Щоденник → ШІ-Репетитор</h1><p class="muted">Читаємо теми й ДЗ через твій звичайний вхід. Пароль, cookies та оцінки не передаємо.</p><form id="form"><div class="dates"><label>Від<input id="start" type="date" required></label><label>До<input id="end" type="date" required></label></div><p class="muted">Для першого тесту — поточний тиждень. Максимум 14 днів.</p><button id="read">Прочитати мій тиждень</button></form><p id="status" role="status" aria-live="polite"></p><div id="output" hidden><button id="copy">Скопіювати дані для репетитора</button><p id="copied" class="muted"></p><a href="https://ai-tutor-8zmb.vercel.app/parent/school" target="_blank" rel="noopener noreferrer">Відкрити репетитор →</a><p class="muted">У режимі тата відкрий «Єдина школа», встав скопійовані дані в поле й переглянь їх перед імпортом.</p><details><summary>Показати дані для ручного копіювання</summary><textarea id="data" readonly aria-label="Дані щоденника"></textarea></details></div></section>`;
  document.body.appendChild(host);
  const field = id => root.getElementById(id);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kiev", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); field("start").value = date.toISOString().slice(0, 10); date.setUTCDate(date.getUTCDate() + 6); field("end").value = date.toISOString().slice(0, 10);
  field("close").onclick = () => host.remove();
  field("form").onsubmit = async event => {
    event.preventDefault(); if (field("read").disabled) return;
    field("read").disabled = true; field("output").hidden = true; field("status").textContent = "Читаємо теми й ДЗ. Залиш цю вкладку відкритою…";
    try {
      const result = await collect(field("start").value, field("end").value);
      if (result?.error) throw Error(result.error);
      if (result?.schemaVersion !== 1) throw Error("ESCHOOL-READ: не вдалося прочитати щоденник.");
      const text = JSON.stringify(result); if (text.length > 1500000) throw Error("Пакет завеликий. Обери коротший період.");
      field("data").value = text; field("output").hidden = false; field("copied").textContent = "";
      field("status").textContent = `Прочитано уроків: ${result.entries.filter(item => item.kind === "lesson").length}; ДЗ: ${result.entries.filter(item => item.kind === "homework").length}.${result.warnings.length ? " Є попередження — переглянь їх у репетиторі." : ""}`;
    } catch (error) { field("status").textContent = error?.message || "Не вдалося прочитати дані. Перевір вхід і повтори."; }
    finally { field("read").disabled = false; }
  };
  field("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(field("data").value); field("copied").textContent = "Дані скопійовано. Тепер відкрий репетитор і встав їх у поле «Дані зі щоденника»."; }
    catch { field("data").closest("details").open = true; field("data").focus(); field("data").select(); field("copied").textContent = "Натисни й утримуй виділений текст → «Копіювати»."; }
  };
}
