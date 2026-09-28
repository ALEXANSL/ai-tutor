/**
 * Ukrainian UI dictionary (ADR-018 K-7). All interface strings live here so a
 * translation later needs no search through code. Tone: docs/04 section 8.
 */
import type { NicknameError, TutorNameError } from "@/lib/persona/validation";

export type TutorGender = "f" | "m";

/** Labels for the notification centre's `safety_alert` card (US-11.6 КП-1). Not exhaustive by design — an unknown value still shows something readable. */
const SAFETY_CATEGORY_UK: Record<string, string> = {
  fear: "страх",
  sadness: "смуток",
  self_harm: "самоушкодження",
  dangerous_act: "небезпечна дія",
  violence: "насильство",
  stranger_contact: "контакт з незнайомцем",
  secret_from_parent: "прохання про секрет",
  personal_data: "особисті дані",
  reward_request: "прохання про нагороду",
  jailbreak: "спроба обійти правила",
  inappropriate_name: "недоречне ім'я репетитора",
  other: "інше",
};
function safetyCategoryUk(category?: string): string {
  return SAFETY_CATEGORY_UK[category ?? ""] ?? category ?? "?";
}
const SAFETY_MODE_UK: Record<string, string> = {
  lesson: "урок",
  tutor_chat: "чат теми",
  friend_chat: "ШІ-друг",
  voice: "голосова розмова",
  tutor_name: "ім'я репетитора",
};
function safetyModeUk(mode?: string): string {
  return SAFETY_MODE_UK[mode ?? ""] ?? mode ?? "?";
}

/**
 * Standard Slavic three-way plural form for a count `n`, given the word's
 * "one" (1, 21, 31…), "few" (2-4, 22-24…) and "many" (0, 5-20, 25-30…) forms.
 * Shared so any new count-based Ukrainian string picks the right form
 * instead of a naive `n === 1 ? singular : plural` (BUG: "сторінок" was
 * used for n=2..4, where "сторінки" is correct).
 */
function ukPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export const uk = {
  app: {
    name: "ШІ-Репетитор",
    shortName: "Репетитор",
    description: "Персональний ШІ-репетитор для навчання вдома",
  },
  theme: {
    light: "☀️ Світла",
    dark: "🌙 Темна",
    label: "Тема оформлення",
  },
  login: {
    title: "ШІ-Репетитор",
    subtitle: "Увійди своїм Google-акаунтом, щоб почати навчання.",
    button: "Увійти через Google",
    hint: "Вхід лише для акаунтів, які додав тато.",
    errors: {
      no_access: "Цей акаунт не має доступу",
      no_access_hint: "Увійди акаунтом, який тато додав до застосунку.",
      auth: "Не вдалося увійти. Спробуй ще раз.",
      config: "Застосунок ще не налаштовано: бракує змінних середовища на сервері.",
    },
  },
  noAccess: {
    title: "Цей акаунт не має доступу",
    body: "Жодних даних не показано. Щоб увійти, використай акаунт, який додав тато.",
    signOut: "Вийти й увійти іншим акаунтом",
  },
  denied: {
    title: "Цей розділ — лише для тата",
    body: "Тут налаштування, які змінює тато.",
    back: "← Повернутися до «Сьогодні»",
  },
  offline: {
    title: "Немає зв'язку",
    body: "Немає зв'язку. Усе збережено — продовжимо, коли з'явиться інтернет.",
    retry: "Спробувати ще раз",
  },
  ai: {
    badge: "Я — ШІ",
    badgeSuffix: "не людина",
    // Gendered forms: always read through gendered() from @/lib/persona/gender (BUG-002).
    roleNoun: { f: "ШІ-помічниця", m: "ШІ-помічник" } satisfies Record<TutorGender, string>,
    states: {
      listening: "Слухаю…",
      thinking: "Секунду, думаю…",
      speaking: (name: string) => `Говорить ${name}`,
      paused: "Мікрофон вимкнено",
    },
  },
  child: {
    onboarding: {
      stepLabel: (step: number, total: number) => `Крок ${step} з ${total}`,
      nickname: {
        title: "Як тебе називати?",
        subtitle: "Придумай прізвисько — не справжнє ім'я. Так до тебе звертатиметься репетитор.",
        placeholder: "Наприклад, Зірочка",
        hint: "Від 2 до 20 символів, без «@», без довгих номерів і посилань.",
        submit: "Далі",
      },
      tutorName: {
        title: "Обери ім'я репетитора",
        subtitle: "Так репетитор представлятиметься. Можна обрати зі списку або придумати своє.",
        submit: "Далі",
      },
      aiIntro: {
        greeting: (nickname: string, tutorName: string) => `Привіт, ${nickname}! Я — ${tutorName}`,
        body: (roleNoun: string) => `Я — ${roleNoun}, не людина. Я допоможу тобі вчитися.`,
        parentCanRead:
          "Дорослі можуть переглянути наші розмови — навіть коли ми просто спілкуємось у «ШІ-другові» — і бачать звіти про заняття.",
        submit: "Зрозуміло, почати!",
        back: "← Назад до «Сьогодні»",
      },
    },
    tutorNamePicker: {
      groupF: "Жіночі імена",
      groupM: "Чоловічі імена",
      custom: "Своє ім'я",
      customPlaceholder: "Напиши ім'я…",
      customHint: "Лише букви, пробіл, дефіс або апостроф — від 2 до 20 символів.",
      genderLabel: "Як говорити про репетитора?",
      gender: { f: "Вона", m: "Він" } satisfies Record<TutorGender, string>,
    },
    today: {
      greeting: (nickname: string) => `Привіт, ${nickname}!`,
      subtitle: "Гарного дня для навчання!",
      myTutor: "🧑‍🏫 Мій репетитор",
      aboutAi: "✦ Я — ШІ",
      friend: "💬 ШІ-друг",
      emptyPlanTitle: "Скоро тут з'явиться план занять",
      emptyPlanBody: "Тато вже готує підручники. Поки що можна налаштувати свого репетитора.",
      subjectsTitle: "Предмети",
      subjectsSubtitle: "Скоро тут можна буде обрати, чим зайнятися.",
      soon: "скоро",
      modulesTile: "Ще модулі",
      // E-22 (US-22.2 КП-5): courses show in their own section with a
      // "курс" badge, next to the school subjects — a course that is
      // inactive (or whose group is inactive) is simply absent (VP-52),
      // never a grey tile.
      coursesTitle: "Курси",
      coursesSubtitle: "Тато підготував для тебе окремі курси.",
      courseBadge: "курс",
      // E-23 (US-23.1, D-105): collapsed, less-prominent block below the
      // main sections (ВП-56 — "б", PO: «Згоден, поки так»).
      otherTitle: "📄 Інше",
      otherSubtitle: "Книги й матеріали, які тато додав окремо.",
    },
    subject: {
      // D-65: the child picks any topic of the textbook, not only the one
      // marked "current" (that stays a priority hint for the forecast plan
      // in the parent cabinet, US-3.1/3.2 — unchanged).
      topicsSubtitle: "Обери тему, з якої почнемо:",
      priorityBadge: "Пріоритет",
      pages: (from: number, to: number) => (from === to ? `стор. ${from}` : `стор. ${from}–${to}`),
    },
    // E-23 (US-23.1, D-105): reading + chat screen for one "Інше" material.
    material: {
      back: "← До «Сьогодні»",
      prev: "← Назад",
      next: "Далі →",
      pageOf: (k: number, n: number) => `Сторінка ${k} з ${n}`,
      pageLabel: (page: number | null) => (page ? `стор. ${page}` : ""),
      empty: "Цю книгу ще не проіндексовано.",
      chatTitle: "Запитати про цю книгу",
      chatPlaceholder: "Напиши своє питання про цю книгу…",
      chatSend: "Надіслати",
      jumpLabel: "Перейти до…",
      jumpToSection: (title: string) => title,
      jumpToPage: (page: number) => `Стор. ${page}`,
      partiallyIndexed: "Деякі сторінки цієї книги не вдалося розпізнати — у тексті можуть бути пропуски.",
    },
    soon: {
      creative: "Скоро тут будуть творчі завдання з відео-інструкціями",
      back: "← Назад до «Сьогодні»",
    },
    lesson: {
      pickTitle: "З чого почнемо?",
      pickSubtitle: "Обери один із блоків",
      startAny: "Почати",
      startingLesson: "Готуємо урок…",
      // BUG (child-facing leak): `startLessonAction` used to surface
      // `uk.parent.subjects.errors.noTextbook` — a PARENT-facing
      // instruction ("додайте й проіндексуйте його в «Мої книги»") that
      // references a screen the child has no access to. This is the
      // child's own copy for the exact same underlying condition (topic has
      // no indexed source material yet): warm, no blame, no admin jargon —
      // matches `today.emptyPlanBody`'s tone ("Тато вже готує підручники…").
      // The "Почати" button is hidden once this is shown (retrying would
      // just fail again the same way) — see `ChildStartLessonButton`.
      notReadyTitle: "Цей урок ще не готовий",
      notReadyBody: "Скажи татові чи мамі — вони знають, що робити 👋",
      stepOf: (k: number, n: number) => `Крок ${k} з ${n}`,
      alarmButton: "🚨 Тривога",
      alarmSaved: "Йди в безпечне місце. Я все збережу, продовжимо потім.",
      offlineBanner: "Немає зв'язку. Усе збережено — продовжимо, коли з'явиться інтернет.",
      idleHint: "Ти тут? Продовжимо?",
      autoPaused: "Заняття на паузі — ти давно нічого не робила. Натисни «Продовжити», коли будеш готова.",
      resume: "Продовжити",
      submitAnswer: "Перевірити",
      nextStep: "Далі",
      tryAgain: "Спробуй ще раз",
      correct: "Правильно!",
      almost: "Майже! Спробуй ще раз",
      // BUG-019: a genuinely wrong answer used to show the same "Майже!" text
      // as a real partial credit — a child (and a watching parent) couldn't
      // tell "close, try again" from "no, that's not it". `incorrect` is
      // shown only for verdict `incorrect`; `almost` stays for `partial`.
      incorrect: "Не зовсім так. Спробуй ще раз",
      // ADR-028/US-6.15: the "explain -> reinforce" remediation cycle —
      // shown inline, in place of the step's own content, never a modal.
      remediationExplainTitle: "Давай розберемось",
      remediationRetryHint: "Спробуй ще одне схоже завдання 👇",
      remediationFallbackTitle: "Ось як це вирішується",
      // BUG-019: the deterministic fast path in `evaluateAnswer` (a bare
      // number, a lettered list, or otherwise differently-formatted answer
      // that matches the reference answer in substance) has no per-question
      // model-written explanation, so it uses this generic, warm one.
      openAnswerCorrectGeneric: "Молодець, правильно! Головне — суть відповіді, а не як саме вона записана.",
      formatChangeOffer: "Здається, це не найкращий формат зараз. Спробуймо інакше?",
      changeFormat: "Так, змінити формат",
      keepGoing: "Ні, продовжуй так",
      summaryTitle: "Урок завершено!",
      summaryBody: "Гарна робота сьогодні.",
      moreLesson: "Ще урок",
      backToToday: "← До «Сьогодні»",
      // D-106: adds the section/topic title (when the cited page falls
      // within one) between the material title and the page number.
      sourceRef: (title: string, page: number | null, sectionTitle?: string | null) => {
        const withSection = sectionTitle ? `${title}, розд. «${sectionTitle}»` : title;
        return page ? `${withSection}, стор. ${page}` : withSection;
      },
      chatTitle: "Запитати репетитора",
      chatPlaceholder: "Напиши своє питання про цю тему…",
      chatSend: "Надіслати",
      dragSort: {
        cardsLabel: "Картки",
        slotsLabel: "Місця",
        check: "Перевірити",
        fillAllFirst: "Заповни всі місця, потім перевір",
        tryAgain: "спробуй ще",
      },
      openAnswerPlaceholder: "Напиши відповідь тут…",
      // BUG-007: offline answer buffering.
      queuedOffline: "Немає зв'язку — твоя відповідь збережена й надішлеться сама, щойно з'явиться інтернет.",
      retryNow: "Спробувати ще раз",
      // BUG-008: reminder shown after a pause of 24h+.
      reminderTitle: "Нагадаємо, про що йшлося минулого разу:",
      reminderContinue: "Продовжити урок",
      // US-6.13: block summary (visible outcome + optional feedback).
      blockDoneTitle: "Блок завершено!",
      blockContinue: "Далі",
      // BUG-031: `continueAfterBlockAction` can take a while (it may need to
      // generate the next block on demand) — this used to give NO visual
      // feedback at all, so the click "did nothing" from the child's side
      // while it was actually still working.
      blockContinueBusy: "Готуємо наступний крок…",
      // BUG-034: shown once the wait above has lasted ~15s+ — the child sees
      // the exit button right below it too, so a long wait never looks like
      // a dead end.
      blockContinueSlowHint: "Урок готує ще цікавіші завдання, це може зайняти хвилину-дві ⏳ Можеш почекати або вийти й повернутися пізніше.",
      feedbackPrompt: "Як тобі цей блок?",
      feedbackInteresting: "Цікаво 🤩",
      feedbackNormal: "Нормально 🙂",
      feedbackBoring: "Нудно 😐",
      feedbackThanks: "Дякую!",
      // BUG-020: explicit exit, instead of the browser's own "back" button —
      // saves the current step (the existing pause/resume mechanism, BUG-008)
      // so "Продовжити" picks up from exactly here next time.
      exitLesson: "Вийти з уроку",
      exitLessonConfirmTitle: "Вийти з уроку?",
      exitLessonConfirmBody: "Усе, що ти вже зробила, збережено. Наступного разу зможеш продовжити з цього самого місця.",
      exitLessonConfirmYes: "Так, вийти",
      exitLessonConfirmNo: "Ні, продовжити урок",
      // Shown on `LessonPausedScreen` after an explicit "Вийти з уроку"
      // (BUG-020), if she opens the lesson's own link again instead of
      // starting fresh from "Сьогодні".
      pausedManualExit: "Ти вийшла з уроку — усе збережено. Продовжиш із того самого місця.",
      // US-12.2: break offer after 20 continuous minutes (налашт.).
      breakOfferTitle: "Ти вже займаєшся якийсь час — може, зробимо перерву?",
      breakOfferBody: "Розімнись, попий води або подивись у вікно.",
      takeBreak: "☕ Перерва",
      skipBreak: "Продовжити без перерви",
      // BUG-016: the lesson route's own error boundary — never Next's generic page.
      crashTitle: "Щось пішло не так",
      crashBody: "Урок не вдалося відкрити. Спробуй ще раз або повернись на «Сьогодні» — усе, що ти вже зробила, збережено.",
      crashRetry: "Спробувати ще раз",
      crashBackToToday: "← До «Сьогодні»",
      // US-6.16 (D-80/D-81): lesson-screen navigation rail (docs/04 §11.4).
      navHome: "🏠 На головну",
      navSubjectList: "📚 Список уроків предмету",
      navPrevModule: "⬅️ Попередній модуль",
      navExplain: "💡 Пояснити",
      explainSending: "Пояснюю…",
      explainFailed: "Зараз не вдалося пояснити ще раз — спробуй, будь ласка, ще раз.",
      // US-6.16 КП-2: read-only preview of the previously completed block.
      prevModuleTitle: "Попередній блок (перегляд)",
      prevModuleBody: "Це те, що ти вже пройшла — тут нічого не можна відповідати, лише переглянути.",
      prevModuleClose: "Закрити й повернутись до уроку",
      // BUG-029: `getPreviousModuleAction` returns `null` when there is no
      // earlier block yet (e.g. the very first block of a lesson) — shown
      // instead of the modal so the button never looks like it "does nothing".
      prevModuleNone: "Це перший блок уроку — попереднього поки немає.",
      // US-6.16 КП-5, ADR-025: the "🔊 Вголос / 🤖 Авто / 🔤 Текстом" switch (docs/04 §5.2).
      speechModeCaption: "Озвучка:",
      speechModeVoice: "Вголос",
      speechModeAuto: "Авто",
      speechModeText: "Текстом",
      audiobookBanner: "Режим «Вголос»: репетитор читає розділ, як аудіокнигу.",
      textModeBanner: "Зараз говоримо текстом",
      narrationPause: "⏸ Пауза",
      narrationReplay: "↺ Повторити",
      // PO complaint (2026-09-28): "довго готує голос" — TTS synthesis for
      // the step's narration has no on-screen feedback at all while it runs
      // (`NarrationPlayer` used to render nothing until the audio arrived),
      // so a multi-second wait looked like nothing was happening. This is
      // shown in its place, matching `blockContinueBusy`'s "give an honest,
      // small status instead of silence" pattern.
      narrationPreparing: "🎧 Готуємо озвучку…",
      // D-111 п.5: PO asked for narration ~10-15% faster, or adjustable
      // "as in most courses". The generated audio is already a fixed 1.1x
      // (`openaiTts`'s `speed` param) — these labels describe the extra
      // playback-rate multiplier the listener chooses on top of that, so
      // "1x" here honestly means "as generated" rather than "OpenAI's
      // untouched default pace".
      narrationSpeedLabel: "Швидкість:",
      narrationSpeedOptions: {
        "0.75": "0.75×",
        "1": "1×",
        "1.25": "1.25×",
        "1.5": "1.5×",
      },
      // ADR-023 (D-76): shown on the progress screen while the topic's first
      // block is still being generated in the background — replaces the old
      // static "Готуємо урок…" with a staged, honest progress view.
      warmup: {
        title: "Готуємо урок…",
        subjectTopicLine: (subject: string, topic: string) => `${subject} · ${topic}`,
        // BUG-035: the old fixed "~1 хвилину" promise didn't match a real
        // wait, which can legitimately take several genuine AI-call passes
        // (planning + up to 3× generate/review) — a realistic range instead
        // of one confident number that turns out wrong.
        etaHint: "Зазвичай це триває 1-3 хвилини, іноді трохи довше",
        stagePlanning: "Складаємо план уроку",
        stageGenerating: "Пишемо урок",
        stageReviewing: "Перевіряємо якість",
        stageRevising: "Допрацьовуємо",
        stageSaving: "Зберігаємо",
        // BUG-035: shown instead of the bare stage label once we know which
        // generate→review pass is running, so 2-3 repeats of
        // "Перевіряємо якість"/"Допрацьовуємо" read as a bounded, expected
        // quality check, not as the screen looping/being stuck.
        stagePassLabel: (pass: number, total: number) => `Перевірка ${pass} з ${total}`,
        // BUG-035: shown after ~90s — reassures without touching the
        // pipeline's own timing/retry logic.
        slowWaitHint: "Ще трохи — перевіряємо, щоб урок був якісним 💛",
      },
    },
    friend: {
      title: "ШІ-друг",
      back: "← Сьогодні",
      parentSeesHint: "Цей чат не приватний — дорослі можуть переглянути, що тут написано.",
      empty: "Напиши щось — і почнемо розмову 🙂",
      placeholder: "Напиши повідомлення…",
      send: "Надіслати",
      thinking: "Секунду…",
    },
    myTutor: {
      title: "Мій репетитор",
      subtitle: "Тут можна змінити, як звати твого репетитора.",
      name: (name: string) => `Ім'я: ${name}`,
      nameHelp: "Так репетитор представляється.",
      voice: "Голос: жіночий, за замовчуванням",
      voiceHelp: "Вибір голосу з'явиться згодом.",
      avatar: "Аватар: Вогник",
      avatarHelp: "Інші аватари з'являться згодом.",
      change: "Змінити",
      save: "Зберегти",
      saved: "Збережено!",
      readOnly: "Змінити може тато.",
      nicknameTitle: "Моє прізвисько",
      nicknameValue: (nickname: string) => `Прізвисько: ${nickname}`,
      back: "← Назад до «Сьогодні»",
      signOut: {
        link: "Вийти з акаунта",
        confirmTitle: "Точно вийти з акаунта?",
        confirmBody: "Знову увійти можна буде своїм Google-акаунтом.",
        yes: "Так, вийти",
        cancel: "Скасувати",
      },
    },
    parentMode: {
      button: "🔒 Режим тата",
      title: "Режим тата",
      prompt: "Введи PIN-код",
      cancel: "Скасувати",
      submit: "Увійти",
      erase: "Стерти",
      // BUG-004: shown right away (no digits needed) when the parent has not set a PIN yet.
      notSet: {
        title: "PIN ще не задано",
        body: "Тато ще не задав PIN — він може зробити це у своєму кабінеті, увійшовши власним Google-акаунтом.",
        ok: "Зрозуміло",
      },
      errors: {
        format: "PIN — від 4 до 6 цифр.",
        wrong: "Неправильний PIN.",
        locked: "Введення тимчасово заблоковано. Спробуй пізніше.",
        not_set: "PIN ще не задано. Тато задає його в кабінеті, увійшовши своїм акаунтом.",
        unavailable: "Режим тата зараз недоступний.",
      },
    },
  },
  validation: {
    nickname: {
      empty: "Напиши прізвисько.",
      too_short: "Прізвисько має бути хоча б з 2 символів.",
      too_long: "Трохи коротше — до 20 символів.",
      at_sign: "Без «@», будь ласка — це схоже на пошту.",
      long_digits: "Спробуй інше прізвисько — це схоже на номер телефону.",
      link: "Без посилань — придумай просто прізвисько.",
      invalid_chars: "Тут є незвичні символи — спробуй інше прізвисько.",
    } satisfies Record<NicknameError, string>,
    tutorName: {
      empty: "Обери ім'я зі списку або напиши своє.",
      too_short: "Ім'я має бути хоча б з 2 букв.",
      too_long: "Трохи коротше — до 20 символів.",
      invalid_chars: "Ім'я може мати лише букви, пробіл, дефіс або апостроф.",
      inappropriate: "Давай обереш інше ім'я — це не дуже підходить для репетитора. Можна вибрати зі списку.",
      kinship: "Репетитор — це ШІ, а не родич чи друг-людина. Давай обереш інше ім'я — можна зі списку.",
      same_as_nickname: "Це ж твоє прізвисько 🙂 Придумай репетиторові інше ім'я.",
    } satisfies Record<TutorNameError, string>,
    notSuggested: "Обери ім'я зі списку або напиши своє.",
    notAllowed: "Зараз змінити не вийшло. Спробуй ще раз.",
  },
  parent: {
    nav: {
      dashboard: "Дашборд",
      notifications: "Сповіщення",
      conversations: "Розмови",
      child: "Профіль дитини",
      directives: "Вказівки й повідомлення",
      budget: "Бюджет і моделі",
      subjects: "Предмети",
      courses: "Курси",
      books: "Мої книги",
      settings: "Налаштування",
      modulesSoon: "Модулі (скоро)",
    },
    shell: {
      menu: "Меню",
      closeMenu: "Закрити меню",
      tabletBadge: "🔒 Режим тата",
      exitParentMode: "Вийти з режиму тата",
      signOut: "Вийти з акаунта",
      autoExitHint: (min: number) => `Автовихід після ${min} хв без дій`,
    },
    dashboard: {
      title: "Дашборд",
      addBook: "➕ Додати книгу",
      today: "Сьогодні",
      todayEmpty: "Занять ще не було",
      unread: "Непрочитаних сповіщень",
      openNotifications: "Відкрити сповіщення ▸",
      summaryTitle: "Щоденний підсумок",
      summaryEmpty: "Підсумок з'явиться після перших уроків.",
      stateTitle: "Швидкий стан",
      childNickname: "Прізвисько доньки",
      notChosenYet: "ще не обрано",
      tutorName: "Ім'я репетитора",
      pinState: "PIN режиму тата",
      pinSet: "задано",
      pinNotSet: "не задано — задайте в «Налаштуваннях»",
    },
    notifications: {
      title: "Центр сповіщень",
      empty: "Сповіщень поки немає.",
      markAllRead: "Позначити всі прочитаними",
      unreadDot: "непрочитане",
      change: "Змінити",
      tags: { system: "Система", urgent: "Терміново" },
      types: {
        nickname_changed: (p: { nickname?: string }) => `Донька обрала нікнейм «${p.nickname ?? ""}»`,
        persona_changed: (p: { field?: string; value?: string }) =>
          p.field === "name"
            ? `Донька змінила образ репетитора: ім'я «${p.value ?? ""}»`
            : "Донька змінила образ репетитора",
        tutor_name_rejected: (p: { name?: string }) => `Ім'я репетитора відхилено перевіркою: «${p.name ?? ""}»`,
        pin_lockout: (p: { lockMinutes?: number }) =>
          `Невдалі спроби PIN на планшеті — введення заблоковано на ${p.lockMinutes ?? 15} хв`,
        budget_state: (p: { state?: string; spent_usd?: number; limit_usd?: number }) =>
          `Витрати на ШІ: $${p.spent_usd ?? "?"} з $${p.limit_usd ?? "?"} — ${
            p.state === "hard_stop" ? "досягнуто 110 %, нові ШІ-виклики зупинено" : p.state === "budget" ? "ліміт вичерпано, увімкнено режим бюджету" : "використано 80 % ліміту"
          }`,
        provider_fallback: (p: { role?: string; from?: string; to?: string }) =>
          `Провайдер ШІ не відповів (${p.from ?? "?"}) — використано резервну модель ${p.to ?? "?"}`,
        lesson_block_needs_review: (p: { topicTitle?: string; title?: string }) =>
          `Тема «${p.topicTitle ?? ""}»: блок «${p.title ?? ""}» не пройшов рецензію — дитині не показано`,
        lesson_started_with_fallback: (p: { topicTitle?: string; reason?: string }) =>
          `Урок з теми «${p.topicTitle ?? ""}» запущено зі спрощеним резервним блоком: ${p.reason ?? "блок не пройшов рецензію"}`,
        safety_alert: (p: { category?: string; mode?: string; isTest?: boolean }) =>
          p.isTest
            ? "Тестове термінове сповіщення (перевірка каналів)"
            : `Тривожна репліка (${safetyCategoryUk(p.category)}) у режимі «${safetyModeUk(p.mode)}»`,
        external_delivery_failed: (p: { channel?: string }) => `Не вдалося доставити термінове сповіщення через ${p.channel ?? "?"}`,
        telegram_linked: () => "Telegram прив'язано до кабінету",
        break_missed: () => "Пропущено пропозицію перерви",
        unknown: "Подія",
      },
      nicknameHint: "Змініть, якщо схоже на справжнє ім'я.",
    },
    conversations: {
      title: "Розмови",
      help: "Дитина знає, що тато бачить усі розмови дослівно (US-12.3) — зокрема «ШІ-друга». Пошук і фільтри за датою з'являться пізніше (S14).",
      listTitle: "Чати",
      empty: "Розмов ще немає.",
      pickHint: "Оберіть чат зліва.",
      noMessages: "У цьому чаті ще немає повідомлень.",
      friendChat: "💬 ШІ-друг",
      unknownChat: "Чат",
      authorLabel: { child: "Дитина", ai: "Репетитор", system: "Система", parent: "Тато" },
    },
    child: {
      title: "Профіль дитини",
      basics: "Основне",
      nickname: "Нікнейм",
      nicknameHelp: "Єдине «ім'я», яке бачать моделі ШІ. Має не бути справжнім ім'ям.",
      notOnboarded: "Донька ще не пройшла перший вхід.",
      tutorTitle: "Репетитор доньки",
      tutorName: "Ім'я репетитора",
      voice: "Голос",
      voiceDefault: "Жіночий, за замовчуванням (вибір голосу — згодом)",
      avatar: "Аватар",
      avatarDefault: "Вогник (за замовчуванням)",
      editableLabel: "Дитина може змінювати образ репетитора (ім'я, голос, аватар)",
      save: "Зберегти",
      saved: "Збережено",
    },
    subjects: {
      title: "Предмети",
      listDesc: "Оберіть предмет і поточну тему за підручником — система побудує прогноз-план: що перевірити, що зараз, що далі.",
      // E-22 (US-22.1, ADR-030): add/rename a school subject, and the
      // active/inactive switch (VP-52: inactive stays a visible grey tile,
      // unlike a course — see uk.parent.courses below).
      add: {
        title: "Додати шкільний предмет",
        namePlaceholder: "Наприклад, «Інформатика»",
        submit: "Додати",
        hint: "Новий предмет одразу видно в переліку, неактивним — додайте матеріал, щоб активувати.",
        added: "Предмет додано.",
      },
      rename: {
        title: "Перейменувати предмет",
        submit: "Зберегти назву",
        saved: "Назву збережено.",
      },
      toggleActive: {
        activate: "Активувати",
        deactivate: "Вимкнути",
        activated: "Предмет активовано.",
        deactivated: "Предмет вимкнено — дитина побачить сіру неактивну плитку.",
      },
      status: { active: "Активовано", inactive: "Не активовано" },
      currentTopic: "Поточна тема",
      currentTopicNone: "Поточну тему ще не обрано",
      noTopicsYet: "У підручнику ще немає тем — теми з'являться після індексації.",
      noTextbookBadge: "Немає підручника",
      open: "Відкрити ▸",
      noTextbook: {
        title: "Активувати предмет поки не можна",
        body: "Для цього предмета ще немає готового підручника: індексація або ще не запущена, або підручник не позначений як «Підручник» і не увімкнений «у уроках».",
        cta: "Перейти в «Мої книги», щоб додати підручник",
      },
      detail: {
        back: "◂ Предмети",
        pickerTitle: "Поточна тема",
        pickerHint: "Оберіть тему зі списку тем підручника — можна почати вводити назву, список звузиться.",
        filterPlaceholder: "Почніть вводити назву теми…",
        filterEmpty: "Нічого не знайдено за цим текстом.",
        pages: (from: number, to: number | null) => (to && to !== from ? `с. ${from}–${to}` : `с. ${from}`),
        save: "Зберегти поточну тему",
        saved: "Збережено. Прогноз-план оновлено.",
        current: "поточна",
        lessonTitle: "Урок (демо)",
        lessonHint: "S3: урок відкривається лише в режимі тата, доки не перевірено правила безпеки (S4).",
        startLesson: "▶ Почати урок",
        startingLesson: "Готуємо урок…",
      },
      errors: {
        noTextbook: "Немає готового підручника цього предмета — спершу додайте й проіндексуйте його в «Мої книги».",
        topicNotFound: "Оберіть тему зі списку тем цього підручника.",
        pickTopicFirst: "Спершу оберіть тему зі списку.",
        startLessonFailed: "Не вдалося підготувати урок. Спробуйте ще раз за кілька хвилин або перевірте налаштування ШІ.",
        invalidName: "Введіть назву предмета (від 1 до 120 символів).",
        duplicateName: "Такий предмет уже є.",
        notFound: "Предмет не знайдено.",
      },
      // US-22.4 (D-108, S33): bulk-select topics + one-click overnight warm-up
      // on the subject detail screen (`/parent/subjects/[id]`).
      bulkWarmup: {
        title: "Масова підготовка уроків",
        hint: "Обери кілька тем (або всі теми предмета) і одним натисканням постав підготовку в чергу на ніч — дитина зранку одразу проходитиме готові уроки.",
        selectAll: "Обрати всі теми предмета",
        selectedCount: (n: number) => (n === 0 ? "Тем не обрано" : `Обрано ${n} тем`),
        prepareButton: "Підготувати уроки",
        pickAtLeastOne: "Оберіть хоча б одну тему.",
        estimating: "Рахуємо вартість…",
        summary: (ready: number, total: number) => `Підготовка: ${ready} з ${total} готово`,
        summaryDone: "Усі підготовлені теми готові ✓",
        status: {
          ready: "✓ Готово",
          queued: "У черзі",
          generating: "⏳ Готується",
          error: "Помилка",
        },
        errorHint: "Резервний варіант спрацює, коли дитина відкриє тему.",
        confirm: {
          title: "Підготувати уроки вночі?",
          lead: "Перевір суму перед запуском — задачі стають у чергу одразу після підтвердження.",
          rowSelected: "Обрано тем",
          rowReady: "Уже готові (не рахуємо)",
          rowNeeded: "Потребують підготовки",
          amountLabel: "Орієнтовна вартість (≈ $0,33 / тему)",
          amount: (usd: number) => `≈ $${usd.toFixed(2)}`,
          awareness: (usd: number) => `Це одноразова витрата ≈ $${usd.toFixed(2)} за ніч.`,
          goButton: (n: number, usd: number) => `Підготувати ${n} тем (≈ $${usd.toFixed(2)})`,
          goButtonNone: "Усі обрані теми вже готові — нічого запускати",
          budgetBlocked: "Місячний ліміт витрат майже вичерпано — підтвердження запуску наразі заблоковане. Збільш ліміт у налаштуваннях бюджету, щоб продовжити.",
          cancel: "Скасувати",
          note: "Жодна задача не ставиться в чергу, доки ти не натиснеш кнопку вище. Місячний ліміт лишається чинним без винятків.",
          started: "Задачі поставлено в чергу на ніч.",
          failed: "Не вдалося поставити задачі в чергу. Спробуйте ще раз.",
        },
      },
      library: {
        title: "Бібліотека блоків теми",
        empty: "Блоків ще немає — з'являться після першого уроку теми.",
        status: {
          active: "Активний",
          needs_review: "Потребує уваги — рецензію не пройдено",
          superseded: "Замінено новішою версією",
          draft: "Чернетка",
          fallback: "Резервний блок (без ШІ)",
        },
        reviewStatus: {
          first_pass: "Пройшов з першого разу",
          revised: "Пройшов після доопрацювання",
          needs_review: "Не пройшов рецензію — дитині не показано",
        },
        open: "Методичний паспорт ▸",
        back: "◂ До предмета",
        passportTitle: "Методичний паспорт",
        goal: "Мета",
        hook: "«Гачок»",
        outcome: "Видимий результат",
        techniques: "Прийоми (P-P)",
        misconceptions: "Типові помилки, які враховано",
        comprehensionChecks: "Як перевіряється розуміння",
        childFeedback: "Оцінка дитини",
        childFeedbackNone: "Дитина ще не оцінила жодного блоку.",
        reviewHistory: "Рецензія (незалежний провайдер)",
        reviewIteration: (n: number) => `Спроба ${n}`,
        reviewVerdict: { approved: "Схвалено", revise: "Відхилено — на доопрацювання", rejected: "Відхилено" },
      },
      plan: {
        title: "Прогноз-план",
        subtitle: "Передумови для перевірки → поточна тема → наступні теми, з посиланнями на сторінки підручника.",
        empty: "План з'явиться після вибору поточної теми.",
        prereqTitle: "Теми-передумови (варто перевірити)",
        prereqEmpty: "Окремих передумов у структурі підручника не знайдено.",
        currentTitle: "Поточна тема",
        nextTitle: "Наступні теми",
        nextEmpty: "Це остання тема в підручнику — наступних тем не знайдено.",
      },
    },
    // E-22 (US-22.2, ADR-030): a deliberately SEPARATE screen/list from
    // "Предмети" (US-22.2 КП-1: "окремий, не той самий список") — курси поза
    // шкільною програмою; active=false fully hides a course from the child
    // (VP-52), unlike a school subject's grey tile.
    courses: {
      title: "Курси",
      listDesc: "Курси поза шкільною програмою — наприклад, за книгою, яку ви самі підготували. Вимкнений курс повністю зникає з дитячого інтерфейсу (на відміну від предметів).",
      empty: "Курсів поки немає.",
      status: { active: "Активовано", inactive: "Вимкнено — приховано від дитини" },
      groupLabel: "Група",
      noGroup: "Без групи",
      open: "Відкрити ▸",
      groupsLink: "Групи курсів ▸",
      add: {
        title: "Додати курс",
        namePlaceholder: "Наприклад, «Claude Prototyping»",
        groupLabel: "Група (необов'язково)",
        noGroupOption: "Без групи",
        submit: "Додати курс",
        added: "Курс додано.",
      },
      detail: {
        back: "◂ Курси",
        renameTitle: "Перейменувати й перегрупувати",
        submit: "Зберегти",
        saved: "Збережено.",
        attachHint: "Щоб додати матеріал курсу — відкрийте книгу в «Мої книги» і оберіть цей курс як предмет.",
        attachCta: "Перейти в «Мої книги»",
      },
      toggleActive: {
        activate: "Активувати",
        deactivate: "Вимкнути",
        activated: "Курс активовано.",
        deactivated: "Курс вимкнено — дитина його більше не бачить.",
      },
      errors: {
        invalidName: "Введіть назву курсу (від 1 до 120 символів).",
        duplicateName: "Такий курс уже є.",
        notFound: "Курс не знайдено.",
        groupNotFound: "Групу не знайдено.",
      },
    },
    courseGroups: {
      title: "Групи курсів",
      listDesc: "Об'єднайте курси в групу (наприклад, «Група ІТ») — тато вимикає всю групу одним перемикачем, або лише окремий курс усередині неї.",
      empty: "Груп поки немає.",
      courseCount: (n: number) => `курсів: ${n}`,
      status: { active: "Активовано", inactive: "Вимкнено — приховано разом з усіма курсами групи" },
      add: {
        title: "Додати групу",
        namePlaceholder: "Наприклад, «Група ІТ»",
        submit: "Додати групу",
        added: "Групу додано.",
      },
      rename: {
        submit: "Зберегти назву",
        saved: "Назву збережено.",
      },
      toggleActive: {
        activate: "Активувати групу",
        deactivate: "Вимкнути групу",
        activated: "Групу активовано.",
        deactivated: "Групу вимкнено — усі її курси приховано від дитини.",
      },
      errors: {
        invalidName: "Введіть назву групи (від 1 до 120 символів).",
        duplicateName: "Така група вже є.",
        notFound: "Групу не знайдено.",
      },
    },
    books: {
      title: "Мої книги",
      empty: "Книг поки немає. Додайте текстовий PDF або EPUB у папку Google Drive і натисніть «Я додав — перевірити папку».",
      listTitle: "Усі книги й матеріали",
      listDesc:
        "Не лише підручники — будь-яка книга з папки Google Drive: художня, науково-популярна, довідник. Тип і предмет визначаються автоматично, їх можна виправити.",
      searchByName: "🔍 Пошук за назвою",
      allSubjects: "Усі предмети",
      noSubject: "Без предмета",
      allTypes: "Усі типи",
      allStatuses: "Усі статуси",
      found: (n: number, total: number) => `Показано ${n} з ${total}`,
      nothingFound: "Нічого не знайдено — змініть пошук або фільтр.",
      col: { file: "Книга", type: "Тип", subject: "Предмет", status: "Статус", use: "В уроках", added: "Додано" },
      useInLessons: "Використовувати в уроках",
      useOn: "Так",
      useOff: "Ні",
      open: "Структура ▸",
      reindex: "Переіндексувати",
      reindexQueued: "Поставлено в чергу на індексацію",
      reindexDeferred: "Індексацію відкладено: увімкнено режим бюджету",
      pages: (n: number, epub: boolean) => (epub ? `${n} розд.` : `${n} стор.`),
      cost: (usd: string) => `≈ $${usd}`,
      costTitle: "Орієнтовна вартість індексації (ШІ)",
      status: {
        queued: "Індексується…",
        indexing: "Індексується…",
        ready: "Готово",
        // ADR-032: some sections (розділи) permanently failed their own
        // structuring, but the rest of the book is usable already.
        ready_partial: "Готово частково",
        error: "Помилка",
        scan_no_text: "Скан не вдалося розпізнати",
        scan_awaiting_ocr: "Скан — очікує підтвердження",
        deferred: "Індексацію відкладено",
        removed: "Видалено з папки",
      } as Record<string, string>,
      // ADR-032: one section's own status (шкала "Структура" на сторінці книги).
      sectionStatus: {
        pending: "У черзі",
        indexing: "Структурується…",
        ready: "✓",
        error: "Помилка",
      } as Record<string, string>,
      retrySection: "Повторити цей розділ",
      progress: {
        download: "завантаження",
        extract: "читання тексту",
        ocr: "розпізнавання сканів",
        embed: "пошуковий індекс",
        structure: "структура",
      } as Record<string, string>,
      ocrProgress: (done: number, total: number) => `Розпізнається: сторінка ${done} з ${total}`,
      ocrConfirm: {
        // Deliberately "ми не знайшли" (we did not find), not "це скан" (this is a scan):
        // this page can also mean our own text-reader failed on a real text PDF, not that
        // the file is a photographed scan — see "Переіндексувати" note below.
        title: (pages: number) => `Ми не знайшли текстового шару (${pages} стор.) — потрібне розпізнавання`,
        estimate: (usd: string) => `Орієнтовна вартість розпізнавання ≈ $${usd}`,
        button: "🔎 Розпізнати",
        small: "Невеликий скан розпізнається автоматично.",
        retryHint: "Якщо це не скан, а звичайний текстовий PDF — спробуйте безкоштовну «Переіндексувати» ще раз, перш ніж розпізнавати.",
      },
      details: {
        scan_no_text: "Скан без текстового шару — сторінок для розпізнавання не знайдено.",
        scan_unreadable:
          "Розпізнати текст не вдалося: сторінки порожні, пошкоджені або нечіткі. Спробуйте покласти якісніший скан і «Переіндексувати».",
        budget_deferred: "Режим бюджету: нові книги (і розпізнавання сканів) відкладено до збільшення ліміту або з 1-го числа.",
        no_subject: "Оберіть предмет і натисніть «Переіндексувати», щоб з'явились теми.",
        drive_not_configured: "Папка Google Drive ще не підключена (змінні середовища).",
        drive_forbidden: "Немає доступу до файлу: перевірте, що сервісний акаунт має роль «Читач» на папці.",
        drive_file_missing: "Файл не знайдено в папці.",
        too_large: "Файл завеликий (понад 150 МБ).",
        extract_failed: "Не вдалося прочитати файл — можливо, він пошкоджений.",
        empty: "У файлі не знайдено тексту.",
        ai_not_configured: "ШІ ще не підключено (ключ API у змінних середовища).",
        ai_failed: "Сервіс ШІ не відповів. Спробуйте «Переіндексувати» пізніше.",
        failed: "Не вдалося проіндексувати. Спробуйте «Переіндексувати».",
        // ADR-032: shown next to the "Готово частково" badge.
        ready_partial: "Один або кілька розділів не вдалося структурувати — решта книги вже готова. Нижче можна повторити лише невдалий розділ.",
      } as Record<string, string>,
      chapterFallback: (n: number) => `Розділ ${n}`,
      upload: {
        button: "Завантажити файл",
        uploading: "Завантажується…",
        done: "Готово! Книга додана і вже індексується.",
        tooLarge: "Файл завеликий: максимум 50 МБ для прямого завантаження з браузера. Покладіть файл у папку Google Drive вручну (кнопка «Відкрити папку в Google Drive» нижче) — там такого обмеження немає.",
        unsupportedType: "Підтримуються лише файли PDF або EPUB.",
        notConfigured: "Пряме завантаження ще не підключено: спершу підключіть Google Drive в Налаштуваннях.",
        failed: "Не вдалося завантажити файл. Спробуйте ще раз або скористайтеся папкою Google Drive нижче.",
      },
      add: {
        title: "Додати книгу",
        steps: "Найпростіше — «Завантажити файл» нижче (до 50 МБ). Для великих сканів: відкрийте папку → покладіть файл → натисніть «Я додав — перевірити папку».",
        openDrive: "☁️ Відкрити папку в Google Drive",
        driveMissing: "Папку Google Drive ще не підключено в налаштуваннях застосунку.",
        hint: "Текстовий PDF або EPUB, легально придбаний або з офіційного джерела. Скани (фото сторінок) не підтримуються.",
        check: "Я додав — перевірити папку",
        checking: "Перевіряю папку…",
        result: (added: number, updated: number, removed: number) =>
          `Готово: нових — ${added}, оновлених — ${updated}, прибраних — ${removed}.`,
        deferred: (n: number) => ` Відкладено через режим бюджету: ${n}.`,
        failed: "Не вдалося перевірити папку. Переконайтеся, що сервісний акаунт має доступ «Читач».",
        notConfigured: "Папку Google Drive ще не підключено: потрібні ID папки й ключ сервісного акаунта в налаштуваннях Vercel.",
        back: "До списку книг",
      },
      access: {
        publicTitle: (level: string) => `Папка Google Drive відкрита «всім, хто має посилання» (${level})`,
        levels: { reader: "право «Читач»", commenter: "право «Коментатор»", writer: "право «Редактор»", unknown: "рівень доступу не визначено" } as Record<string, string>,
        publicBody: "Будь-хто з посиланням бачить файли. Рекомендуємо обмежити доступ:",
        howTo: [
          "Відкрийте папку в Google Drive → «Поділитися».",
          "У блоці «Загальний доступ» оберіть «Обмежений доступ».",
          "Переконайтеся, що сервісний акаунт застосунку лишився в списку з роллю «Читач».",
        ],
        unknownTitle: "Не вдалося перевірити, чи папка відкрита за посиланням",
        unknownBody: "Перевірте API-ключ Google у налаштуваннях Vercel (ключ з обмеженням на Google Drive API).",
        recheck: "Перевірити ще раз",
      },
      search: {
        title: "Перевірити пошук по матеріалах",
        placeholder: "Наприклад: дроби зі спільним знаменником",
        submit: "Шукати",
        none: "Нічого не знайдено. Перевірте, що книги проіндексовані й увімкнені.",
        textOnly: "Пошук працює лише за словами: пошук за змістом тимчасово недоступний.",
        page: (p: number) => `с. ${p}`,
        failed: "Пошук не вдався. Спробуйте ще раз.",
      },
      detail: {
        back: "◂ Мої книги",
        settings: "Тип, предмет і використання",
        kind: "Тип",
        subject: "Предмет",
        provenance: "Походження / ліцензія (необов'язково)",
        provenanceHint: "Напр.: «придбано в книгарні», «офіційний сайт МОН».",
        save: "Зберегти",
        saved: "Збережено. Ручні виправлення не перезапишуться при переіндексації.",
        structure: "Структура: розділ → тема → сторінки",
        structureEmpty: "Структура з'явиться після індексації.",
        topicsFor: "Теми",
        edit: "Виправити",
        topicTitle: "Назва теми",
        pageFrom: "Стор. з",
        pageTo: "по",
        manual: "виправлено вручну",
        linksTitle: "Прив'язка до тем підручників",
        linksHint: "Для художніх, науково-популярних книг і довідників: до яких тем програми книга підходить.",
        linksEmpty: "Тем ще немає — спершу проіндексуйте підручник предмета.",
        linksSave: "Зберегти прив'язку",
        cost: "Вартість індексації",
        info: "Відомості",
        pagesLabel: "Обсяг",
        grade: "Клас (з книги)",
        indexedAt: "Проіндексовано",
        driveName: "Файл у папці",
        saveTopic: "Зберегти тему",
        ocrUnreadable: "Розпізнано не повністю",
        ocrUnreadableValue: (n: number) => `${n} ${ukPlural(n, "сторінку", "сторінки", "сторінок")} не вдалося розпізнати — можливо, скан нечіткий.`,
      },
    },
    // ADR-031 §3: ZIP з кількома предметними теками (напр. від сторонньої
    // "розкладки" підручника) — "Розібрати архів" -> перегляд/правка
    // мапування предметів -> "Імпортувати". Жодного запису в базу до кліку
    // "Імпортувати" (крок 3).
    manualImport: {
      title: "Пакетний імпорт із ZIP",
      back: "◂ Мої книги",
      empty: "Пакетів поки немає. Покладіть ZIP-архів у папку Google Drive і натисніть «Я додав — перевірити папку» на сторінці «Мої книги».",
      listDesc: "ZIP з кількома предметними теками (кожна — власний index.json + pages.jsonl). Спершу «Розібрати архів» — це нічого не записує, лише показує, що всередині.",
      col: { name: "Архів", status: "Статус", added: "Знайдено" },
      status: {
        pending_review_unparsed: "Ще не розібрано",
        pending_review: "Готово до перегляду",
        importing: "Імпортується…",
        done: "Імпортовано",
        error: "Помилка",
      } as Record<string, string>,
      errorDetail: {
        single_manifest_not_supported: "Це ZIP одного підручника (manifest.json у корені), а не пакет кількох предметів — цей екран для іншого формату.",
        empty_zip: "У ZIP не знайдено жодної предметної теки.",
        drive_not_configured: "Папка Google Drive ще не підключена.",
        drive_forbidden: "Немає доступу до файлу в Google Drive.",
        drive_file_missing: "Файл не знайдено в папці.",
        too_large: "Файл завеликий (понад 150 МБ).",
        reparse_mismatch: "Вміст архіву змінився з моменту розбору — натисніть «Розібрати архів» ще раз.",
      } as Record<string, string>,
      parse: {
        button: "🔎 Розібрати архів",
        queued: "Розбір поставлено в чергу…",
      },
      open: "Переглянути ▸",
      confirm: {
        title: "Перевірте розподіл по предметах",
        intro: "Нижче — кожна предметна тека з архіву. Оберіть предмет (або створіть новий) для кожної, або позначте «Не імпортувати». Нічого не запишеться в базу, доки ви не натиснете «Імпортувати».",
        folderCounts: (importable: number, imageOnly: number, needsReview: number) => {
          const parts = [`придатно до імпорту: ${importable}`];
          if (imageOnly > 0) parts.push(`скан без тексту (не імпортується): ${imageOnly}`);
          if (needsReview > 0) parts.push(`потребує ручної перевірки: ${needsReview}`);
          return parts.join(" · ");
        },
        rejected: "Уся тека — скановані сторінки без тексту. Додайте оригінальний PDF окремо для розпізнавання (OCR).",
        parseError: "Не вдалося розібрати цю теку (немає index.json/pages.jsonl або файл пошкоджено) — пропущено.",
        needsReviewTitle: "Потребує ручної перевірки (не імпортується автоматично):",
        subjectLabel: "Предмет",
        subjectPlaceholder: "— оберіть —",
        createSubjectOption: "➕ Створити новий предмет",
        newSubjectPlaceholder: "Назва нового предмета",
        skipOption: "Не імпортувати цю теку",
        submit: "Імпортувати",
        started: "Імпорт поставлено в чергу.",
        alreadyImported: "Уже імпортовано раніше.",
      },
      report: {
        title: "Результат імпорту",
        imported: (topics: number) => `Імпортовано: ${topics} ${ukPlural(topics, "тему", "теми", "тем")}.`,
        rejected_scan: "Відхилено — скан без тексту, додайте оригінальний PDF для розпізнавання.",
        skipped_by_parent: "Пропущено — ви обрали «не імпортувати».",
        already_imported: "Уже було імпортовано раніше.",
        error: "Помилка імпорту цієї теки.",
        needsReview: (n: number) => (n > 0 ? ` Потребує ручної перевірки: ${n}.` : ""),
        imageOnlySkipped: (n: number) => (n > 0 ? ` Пропущено (скан у тексті теки): ${n}.` : ""),
      },
    },
    settings: {
      title: "Налаштування",
      pinTitle: "PIN режиму тата",
      pinHelp: "4–6 цифр. Потрібен, щоб відкрити кабінет на планшеті доньки. Зберігається лише у вигляді хешу.",
      pinCurrentSet: "PIN задано",
      pinCurrentNotSet: "PIN ще не задано",
      pinNew: "Новий PIN",
      pinRepeat: "Повторіть PIN",
      pinSave: "Зберегти PIN",
      pinSaved: "PIN збережено",
      pinMismatch: "PIN-коди не збігаються.",
      pinFormat: "PIN — від 4 до 6 цифр.",
      pinOnlyOwnAccount: "Змінити PIN можна лише увійшовши своїм Google-акаунтом (не з режиму тата на планшеті).",
      pinLockedUntil: (time: string) => `Введення PIN на планшеті заблоковано до ${time}`,
      policy: (attempts: number, lockMin: number, idleMin: number) =>
        `Після ${attempts} неправильних спроб — блокування на ${lockMin} хв. Автовихід з режиму тата — після ${idleMin} хв без дій.`,
      // S4 (ADR-010, US-11.7): urgent e-mail + Telegram channel status.
      urgentTitle: "Термінові сповіщення",
      urgentHelp: "Лише для термінових тривожних сигналів (US-12.1) — не для будь-яких інших подій (D-12).",
      emailConfigured: "E-mail (Resend): налаштовано",
      // The exact variable-name wording (BUG-005 pattern) lives server-only in
      // `lib/urgent-channel-messages.ts` — `check:bundle` treats a secret
      // variable's NAME as a leak too, so it must never reach this shared
      // dictionary (client components import `uk`).
      emailNotConfigured: "E-mail (Resend): не налаштовано.",
      telegram: {
        linked: "Telegram: прив'язано",
        notLinked: "Telegram: не прив'язано",
        link: "🔗 Прив'язати Telegram",
        linkHint: "Відкриє чат з ботом — натисніть у ньому «Start» протягом 10 хв.",
        unlink: "Відв'язати",
        unlinked: "Telegram відв'язано.",
        test: "📨 Надіслати тестове термінове сповіщення",
        testSent: "Тестове сповіщення надіслано (позначка «ТЕСТ») — перевірте пошту і Telegram.",
      },
      // ADR-024: shared OAuth `drive.file` connector (book upload; later also the media archive).
      drive: {
        title: "Google Drive",
        onlyOwnAccount: "Підключити Google Drive можна лише увійшовши своїм Google-акаунтом (не з режиму тата на планшеті).",
        help: "Один дозвіл — і застосунок сам створює свою окрему папку «ШІ-Репетитор — Мої книги» для завантажених книг; до решти вашого Google Диска доступу не отримує.",
        notConnected: "Google Drive: не підключено",
        connected: (at: string | null) => `Google Drive: підключено${at ? ` (${at})` : ""}`,
        connect: "🔗 Підключити Google Drive",
        justConnected: "Google Drive підключено.",
        folderCreated: "Папку «ШІ-Репетитор — Мої книги» створено й відкрито для індексації.",
        // `pasteHint` and the `not_configured` error name an exact env var —
        // BUG-005 pattern, kept server-only in `lib/drive-connect-messages.ts`
        // instead, passed to the panel already resolved.
        errors: {
          denied: "Google Drive не підключено: дозвіл не надано.",
          state: "Не вдалося підтвердити запит (застарілий або невірний). Спробуйте підключити ще раз.",
          failed: "Не вдалося підключити Google Drive. Спробуйте ще раз.",
        } as Record<string, string>,
      },
    },
    placeholder: {
      title: (name: string) => name,
      body: "Цей розділ з'явиться в наступних оновленнях.",
    },
  },
  common: {
    error: "Щось пішло не так. Спробуйте ще раз.",
  },
} as const;
