/** Self-contained: Chrome serializes this function into the diary tab's MAIN world. */
export async function collectEsSchool(start, end) {
  try {
  if (location.origin !== "https://diary.eschool-ua.com") throw Error("ESCHOOL-ORIGIN: відкрий diary.eschool-ua.com.");
  const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  const span = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (!day(start) || !day(end) || !Number.isFinite(span) || span < 0 || span > 13) throw Error("ESCHOOL-DATES: обери до 14 днів.");
  const deadline = Date.now() + 85000;
  const number = value => Number.isSafeInteger(value) && value > 0;
  const plain = value => {
    if (typeof value !== "string") return "";
    const cleaned = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?\s*>|<\/(p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "");
    const decoder = document.createElement("textarea"); decoder.innerHTML = cleaned;
    return decoder.value.replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
  };
  async function get(path, params = {}) {
    if (!(/^\/api\/(profile|v1\/seplogin)$/.test(path) || /^\/api\/v1\/\d+\/(SchoolBoy\/\d+\/Appointment|Homework\/\d+)$/.test(path))) throw Error("ESCHOOL-PATH");
    const url = new URL(path, location.origin); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const left = deadline - Date.now(); if (left <= 0) throw Error("ESCHOOL-TIME: спробуй коротший діапазон дат.");
    let response;
    try { response = await fetch(url, { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(Math.min(12000, left)), headers: { accept: "application/json" } }); }
    catch (error) { throw Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? "ESCHOOL-TIMEOUT" : "ESCHOOL-NETWORK"); }
    if (response.status === 401 || response.status === 403) throw Error("ESCHOOL-LOGIN: увійди у щоденник та відкрий профіль дитини, потім повтори.");
    if (!response.ok) throw Error(`ESCHOOL-HTTP-${response.status}: сервіс не відповів. Спробуй пізніше.`);
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw Error("ESCHOOL-LOGIN: відкрий щоденник і перевір вхід.");
    let text;
    try { text = await response.text(); }
    catch (error) { throw Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? "ESCHOOL-TIMEOUT" : "ESCHOOL-NETWORK"); }
    if (text.length > 5000000) throw Error("ESCHOOL-SIZE: обери коротший діапазон.");
    try { return JSON.parse(text); } catch { throw Error("ESCHOOL-JSON"); }
  }
  const profile = await get("/api/profile");
  if (!number(profile.Id) || !number(profile.SchoolId)) throw Error("ESCHOOL-PROFILE: формат профілю змінився.");
  const bindings = await get("/api/v1/seplogin");
  if (!Array.isArray(bindings.Items) || !bindings.Items.some(item => item?.role === "schoolboy" && item.user_id === profile.Id && item.school_id === profile.SchoolId)) throw Error("ESCHOOL-PUPIL: у щоденнику обери профіль учня, а не вчителя чи інший кабінет.");
  const reply = await get(`/api/v1/${profile.SchoolId}/SchoolBoy/${profile.Id}/Appointment`, { start, end, embed: "Topic,TargetHomework", fileRole: "schoolboy" });
  if (!Array.isArray(reply.Items)) throw Error("ESCHOOL-SCHEDULE: формат розкладу змінився. Дані не передано.");
  if (reply.Items.length > 200) throw Error("ESCHOOL-SIZE: забагато уроків. Обери коротший діапазон.");
  const warnings = []; const lessons = reply.Items;
  if (number(reply.Quantity) && reply.Quantity > lessons.length) warnings.push("Сервіс повернув лише частину розкладу. Спробуй коротший діапазон дат.");
  for (const lesson of lessons) if (!number(lesson?.Id) || !day(lesson.Date)) throw Error("ESCHOOL-LESSON: невідомий формат уроку. Дані не передано.");
  const homeworkIds = [...new Set(lessons.flatMap(lesson => (lesson.Embed?.TargetHomeworks ?? []).filter(item => number(item?.Id)).map(item => item.Id)))];
  if (homeworkIds.length > 120) throw Error("ESCHOOL-SIZE: забагато ДЗ. Обери коротший діапазон.");
  const details = new Map(); let cursor = 0; let fatal = null; let stopDetails = null;
  function detailWarning(id, code) {
    const reason = code === "ESCHOOL-HTTP-429" ? "сервіс обмежив частоту запитів"
      : code === "ESCHOOL-TIMEOUT" || code === "ESCHOOL-TIME" ? "закінчився час очікування"
      : (code === "ESCHOOL-HOMEWORK-SHAPE" || code === "ESCHOOL-JSON") ? "формат відповіді змінився"
      : code === "ESCHOOL-NETWORK" ? "помилка з’єднання" : "сервіс не повернув деталі";
    warnings.push(`ДЗ ${id}: додаткові деталі не отримано — ${reason} (${code}). Збережено текст із розкладу; звір його й вкладення з оригіналом.`);
  }
  async function worker() {
    while (cursor < homeworkIds.length && !fatal) {
      const id = homeworkIds[cursor++];
      if (stopDetails) { detailWarning(id, stopDetails); continue; }
      try { const item = await get(`/api/v1/${profile.SchoolId}/Homework/${id}`, { embed: "File" }); if (item?.Id !== id) throw Error("ESCHOOL-HOMEWORK-SHAPE"); details.set(id, item); }
      catch (error) {
        if (/ESCHOOL-LOGIN/.test(error.message)) { fatal = error; return; }
        const code = /^ESCHOOL-(?:HTTP-\d{3}|TIMEOUT|TIME|HOMEWORK-SHAPE|NETWORK|SIZE|JSON)\b/.exec(error?.message ?? "")?.[0] ?? "ESCHOOL-DETAIL";
        if (code === "ESCHOOL-HTTP-429" || code === "ESCHOOL-TIME") stopDetails = code;
        detailWarning(id, code);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, homeworkIds.length) }, worker)); if (fatal) throw fatal;
  const entries = new Map();
  for (const lesson of lessons) {
    const topics = Array.isArray(lesson.Embed?.Topics) ? lesson.Embed.Topics.filter(Boolean) : [];
    const subject = plain(lesson.Subject || lesson.Part) || "Предмет без назви";
    const base = { appointmentId: lesson.Id, subjectExternalId: number(lesson.SubjectId) ? lesson.SubjectId : null, subject, lessonDate: day(lesson.Date), dueDate: null, topic: topics.map(topic => plain(topic.Title)).filter(Boolean).join("; "), text: "", attachments: 0, cancelled: lesson.Canceled === true };
    entries.set(`lesson:${lesson.Id}`, { ...base, externalId: `lesson:${lesson.Id}`, kind: "lesson" });
    const homework = Array.isArray(lesson.Embed?.TargetHomeworks) ? lesson.Embed.TargetHomeworks.filter(item => number(item?.Id)) : [];
    for (const brief of homework) {
      const detail = details.get(brief.Id);
      const item = detail ? Object.fromEntries(Object.keys({ ...brief, ...detail }).map(key => [key, detail[key] ?? brief[key]])) : brief;
      const entry = { ...base, externalId: `homework:${item.Id}`, kind: "homework", lessonDate: day(item.AppointmentDate) ?? base.lessonDate, dueDate: day(item.TargetAppointmentDate), topic: plain(item.Topic) || base.topic, text: plain(item.Description), attachments: Number.isSafeInteger(item.FilesCount) && item.FilesCount >= 0 ? item.FilesCount : (Array.isArray(item.Embed?.Files) ? item.Embed.Files.length : 0) };
      entries.set(entry.externalId, entry);
    }
    if (!homework.length) for (const topic of topics) if (number(topic.Id) && plain(topic.Homework)) {
      const id = `topic:${topic.Id}:${lesson.Id}`; entries.set(id, { ...base, externalId: id, kind: "homework", topic: plain(topic.Title) || base.topic, text: plain(topic.Homework) });
    }
  }
  const result = [...entries.values()];
  if (result.some(entry => entry.text.length > 16000 || entry.topic.length > 2500 || entry.subject.length > 180)) throw Error("ESCHOOL-TEXT-SIZE: великий опис. Обери окремий урок.");
  return { schemaVersion: 1, packetId: crypto.randomUUID(), capturedAt: new Date().toISOString(), identity: { schoolId: profile.SchoolId, pupilId: profile.Id, classLabel: plain(profile.Class).slice(0, 40) }, range: { start, end }, entries: result, complete: warnings.length === 0, warnings: warnings.slice(0, 150) };
  } catch (error) {
    return { error: error instanceof Error && error.message.startsWith("ESCHOOL-") ? error.message : "ESCHOOL-CONNECTION: не вдалося прочитати щоденник. Перевір вхід і спробуй ще раз." };
  }
}
