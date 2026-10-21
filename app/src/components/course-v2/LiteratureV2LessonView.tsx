"use client";

import type { VoiceTarget } from "@/lib/voice";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { OpenTextbookPageButton } from "@/components/shared/BookPageModal";
import { MathText } from "@/components/shared/MathText";
import { LessonVoicePanel } from "@/components/voice/LessonVoicePanel";
import { NarrationButton } from "@/components/shared/NarrationButton";
import { useAudioPlaybackScope } from "@/components/shared/useAudioPlaybackScope";
import { STEP_NAV_BAR_SPACER_CLASS, StepNavBar } from "@/components/shared/StepNavBar";
import { AutoAdvanceToggle, VoiceModeToggle, useVoiceModeControls } from "@/components/shared/VoiceModeControls";
import { askTopicChatAction } from "@/app/actions/lesson";
import { explainLiteratureV2Action, narrateLiteratureV2Action, revealLiteratureV2TaskHelpAction, type LiteratureV2TaskHelpResult } from "@/app/actions/literature-course-v2";
import type { LiteratureV2LessonListItem, LiteratureV2LessonView, LiteratureV2TaskView } from "@/server/lessons/literatureV2View";

interface TextbookRef {
  materialId: string;
  title: string;
  pageCount: number | null;
}

/**
 * S36 — child-facing viewer for one imported `literature_v2_lessons` row.
 * Structurally mirrors `MathCourseV2LessonView.tsx` (S35) — screens shown
 * one at a time, voice mode/auto-advance, "💡 Пояснити" — but every task
 * here is OPEN-RESPONSE: there is no "submit and get graded" step, only a
 * "Показати підказки" reveal (hints/model answer/criteria), same spirit as
 * S35's "Показати розв'язання" but for a task with no single correct answer
 * (`revealLiteratureV2TaskHelpAction` never sends this content before the
 * child asks for it, same "ключі не передаються перед відповіддю" rule).
 */

function ListenButton(props: {
  refTable: string; refId: string; field: string; text: string;
  autoPlay?: boolean; onEnded?: () => void;
}) {
  const { refTable, refId, field, text } = props;
  return <NarrationButton {...props} identity={JSON.stringify([refTable, refId, field, text])}
    synthesize={() => narrateLiteratureV2Action({ refTable, refId, field, text })} />;
}

/**
 * PO complaint 2026-10-08: the explanation used to land in the single
 * shared `LessonTopicChat` panel elsewhere on the page — "абсолютно не
 * зручно шукати звідки ШІ читає текст" when there are 10+ tasks on the
 * screen. It now renders directly below THIS button instead (own local
 * state, no `chatRef`) — the shared chat panel stays only for the
 * free-form "💬 Запитати репетитора" question box.
 */
type ExplainButtonProps = { subjectId: string; topicId: string | null; stepText: string; refTable: string; refId: string };
function ExplainButton(props: ExplainButtonProps) {
  return <ScopedExplainButton key={JSON.stringify([props.refTable, props.refId, props.stepText])} {...props} />;
}

function ScopedExplainButton({ subjectId, topicId, stepText, refTable, refId }: ExplainButtonProps) {
  const [state, setState] = useState<{ status: "idle" } | { status: "pending" } | { status: "done"; content: string }>({ status: "idle" });
  const [audio, setAudio] = useState<{ base64: string; mime: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const playback = useAudioPlaybackScope();

  if (!topicId || !stepText.trim()) return null;

  function playAudio(base64: string, mime: string, request = playback.begin(() => setPlaying(false))) {
    if (!request.isCurrent()) return;
    const el = new Audio(`data:${mime};base64,${base64}`);
    setPlaying(true);
    request.play(el, () => setPlaying(false));
  }

  async function explain() {
    if (state.status === "pending") return;
    const request = playback.begin(() => setPlaying(false));
    setState({ status: "pending" });
    setAudio(null);
    try {
      const res = await explainLiteratureV2Action({ subjectId, topicId: topicId!, stepText });
      if (!playback.isMounted()) return;
      const content = res.status === "ok" ? res.content : res.message;
      setState({ status: "done", content });
      if (res.status === "ok" && request.isCurrent()) {
        try {
          const narration = await narrateLiteratureV2Action({ refTable, refId, field: "explanation", text: content });
          if (narration.status === "ok" && request.isCurrent()) {
            setAudio({ base64: narration.audioBase64, mime: narration.audioMime });
            playAudio(narration.audioBase64, narration.audioMime, request);
          }
        } catch {
          // voice is a bonus on top of the text already shown below
        }
      }
    } catch (e) {
      if (!playback.isMounted()) return;
      setState({ status: "done", content: `Не вдалося пояснити (${(e as Error).message}). Спробуй ще раз.` });
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => void explain()} disabled={state.status === "pending"} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
          {state.status === "pending" ? "…" : "💡 Пояснити"}
        </button>
        {audio && (
          <button
            type="button"
            onClick={() => playAudio(audio.base64, audio.mime)}
            disabled={playing}
            className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60"
          >
            {playing ? "🔊 Грає…" : "🔁 Ще раз"}
          </button>
        )}
      </div>
      {state.status === "done" && (
        <div className="mt-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
          <MathText text={state.content} />
        </div>
      )}
      <LessonVoicePanel target={{ kind: "course", refTable, refId }} />
    </div>
  );
}

function ScreenNav({ lesson, voiceMode, autoAdvance, index, onIndexChange }: { lesson: LiteratureV2LessonView; voiceMode: boolean; autoAdvance: boolean; index: number; onIndexChange: (index: number) => void }) {
  const screen = lesson.screens[index];
  if (!screen) return <p className="course-note">Екранів ще немає.</p>;

  const isLast = index >= lesson.screens.length - 1;
  const onNarrationEnded = voiceMode && autoAdvance && !isLast ? () => onIndexChange(Math.min(lesson.screens.length - 1, index + 1)) : undefined;

  return (
    <section>
      {screen.stepType && <p className="course-eyebrow">{screen.stepType}</p>}
      <p style={{ whiteSpace: "pre-wrap" }}>
        <MathText text={screen.content.display} />
      </p>
      {screen.assets.map((a) =>
        a.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
          <img key={a.assetKey} src={a.url} alt={a.alt} className="course-exercise-asset" style={{ maxWidth: "100%", height: "auto" }} />
        ) : null,
      )}
      {screen.assets.map((a) => a.caption && <p key={a.assetKey} className="text-xs text-muted">{a.caption}</p>)}
      <div className="mt-2 flex flex-wrap gap-2">
        <ListenButton key={screen.id} refTable="literature_v2_screens" refId={screen.id} field="narration" text={screen.content.tts.text} autoPlay={voiceMode} onEnded={onNarrationEnded} />
        <ExplainButton subjectId={lesson.subjectId} topicId={lesson.topicId} stepText={screen.content.display} refTable="literature_v2_screens" refId={screen.id} />
      </div>
      <StepNavBar
        label={`Екран ${index + 1} з ${lesson.screens.length}`}
        backDisabled={index === 0}
        onBack={() => onIndexChange(Math.max(0, index - 1))}
        nextDisabled={index >= lesson.screens.length - 1}
        onNext={() => onIndexChange(Math.min(lesson.screens.length - 1, index + 1))}
        middleControl={
          lesson.textbookMaterialId && (
            <OpenTextbookPageButton
              materialId={lesson.textbookMaterialId}
              title={lesson.textbookTitle ?? lesson.packageTitle}
              pageCount={lesson.textbookPageCount}
              page={lesson.printedPageFrom}
              label="📖 Відкрити підручник"
            />
          )
        }
      />
    </section>
  );
}

export interface LessonTopicChatHandle {
  pushAndOpen(content: string): void;
}

const LessonTopicChat = forwardRef<LessonTopicChatHandle, { subjectId: string; topicId: string; target?: VoiceTarget }>(function LessonTopicChat({ subjectId, topicId, target }, ref) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ author: "child" | "ai"; content: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    pushAndOpen(content: string) {
      setMessages((prev) => [...prev, { author: "ai", content }]);
      setOpen(true);
    },
  }));

  async function send() {
    const q = question.trim();
    if (!q || pending) return;
    setMessages((prev) => [...prev, { author: "child", content: q }]);
    setQuestion("");
    setPending(true);
    setError(null);
    try {
      const res = await askTopicChatAction(null, subjectId, topicId, q, target);
      if (res.status === "ok") setMessages((prev) => [...prev, { author: "ai", content: res.message.content }]);
      else setError("Не вдалося надіслати запитання. Спробуй ще раз.");
    } catch (e) {
      setError(`Не вдалося надіслати запитання (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-6">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-bold text-muted underline">
        💬 Запитати репетитора про цю тему
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-line bg-surface p-3.5">
          {messages.length > 0 && (
            <div className="mb-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm">
              {messages.map((m, i) => (
                <p key={i} className={m.author === "child" ? "font-bold" : "text-muted"}>
                  <MathText text={m.content} />
                </p>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder="Поясни цю тему…"
              disabled={pending}
              className="min-h-11 flex-1 rounded-xl border-2 border-line bg-surface px-3 text-sm"
            />
            <button type="button" onClick={() => void send()} disabled={pending || !question.trim()} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">
              {pending ? "…" : "Надіслати"}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1.5 text-xs font-bold text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
});

function TaskCard({ task, subjectId, topicId, textbook, onFocusTarget }: { task: LiteratureV2TaskView; subjectId: string; topicId: string | null; textbook: TextbookRef | null; onFocusTarget: (target: VoiceTarget) => void }) {
  const [revealed, setRevealed] = useState<LiteratureV2TaskHelpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await revealLiteratureV2TaskHelpAction({ taskId: task.id });
      if (res.status === "ok") setRevealed(res.result);
      else setError(res.message);
    } catch (e) {
      setError(`Не вдалося показати підказки (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="course-exercise-card" onPointerDownCapture={() => onFocusTarget({ kind: "course", refTable: "literature_v2_tasks", refId: task.id })} onFocusCapture={() => onFocusTarget({ kind: "course", refTable: "literature_v2_tasks", refId: task.id })}>
      {task.originalLabel && <p className="course-exercise-number">{task.originalLabel}</p>}
      <p style={{ whiteSpace: "pre-wrap" }}>
        <MathText text={task.prompt.display} />
      </p>
      {task.subtasks.length > 0 && (
        <ol className="mt-1 list-decimal pl-5 text-sm">
          {task.subtasks.map((s) => (
            <li key={s.id}>
              <MathText text={s.display} />
            </li>
          ))}
        </ol>
      )}
      {task.assets.map((a) =>
        a.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
          <img key={a.assetKey} src={a.url} alt={a.alt} className="course-exercise-asset mt-2" style={{ maxWidth: "100%", height: "auto" }} />
        ) : null,
      )}
      {task.assets.map((a) => a.caption && <p key={a.assetKey} className="text-xs text-muted">{a.caption}</p>)}
      {task.table && (
        <div className="mt-2 overflow-x-auto">
          <table className="course-task-table w-full border-collapse text-sm">
            <thead>
              <tr>
                {task.table.columns.map((c, i) => (
                  <th key={i} className="border border-line p-1.5 text-left font-bold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {task.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="border border-line p-1.5">
                      {cell || <span className="text-muted">…</span>}
                    </td>
                  ))}
                </tr>
              ))}
              {task.table.rows.length === 0 && (
                <tr>
                  {task.table.columns.map((_, i) => (
                    <td key={i} className="border border-line p-1.5 text-muted">
                      …
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {textbook && task.printedPage != null && <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={task.printedPage} numberKeywordHint="завдання" />}
        <ListenButton refTable="literature_v2_tasks" refId={task.id} field="narration" text={task.prompt.tts.text} />
        <ExplainButton subjectId={subjectId} topicId={topicId} stepText={task.prompt.display} refTable="literature_v2_tasks" refId={task.id} />
        {!revealed && task.hasHint && (
          <button type="button" onClick={reveal} disabled={busy} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
            {busy ? "…" : "Показати підказки"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-danger">
          {error}
        </p>
      )}
      {revealed && (
        <div className="mt-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
          {revealed.hints.length > 0 && (
            <ul className="list-disc pl-5">
              {revealed.hints.map((h, i) => (
                <li key={i}>
                  <MathText text={h.display} />
                </li>
              ))}
            </ul>
          )}
          {revealed.criteria.length > 0 && (
            <div className="mt-2">
              <p className="font-bold">На що звернути увагу:</p>
              <ul className="list-disc pl-5">
                {revealed.criteria.map((c, i) => (
                  <li key={i}>{c.criterion}</li>
                ))}
              </ul>
            </div>
          )}
          {revealed.answer && (
            <p className="mt-2">
              <span className="font-bold">Можлива відповідь: </span>
              <MathText text={revealed.answer.display} />
            </p>
          )}
          {revealed.acceptableAlternatives.length > 0 && (
            <p className="mt-1 text-xs text-muted">{revealed.acceptableAlternatives.join(" ")}</p>
          )}
        </div>
      )}
    </li>
  );
}

const TASKS_PER_PAGE = 10;

function TaskList({ tasks, subjectId, topicId, textbook, onFocusTarget }: { tasks: LiteratureV2TaskView[]; subjectId: string; topicId: string | null; textbook: TextbookRef | null; onFocusTarget: (target: VoiceTarget) => void }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(tasks.length / TASKS_PER_PAGE);
  const start = page * TASKS_PER_PAGE;
  const visible = tasks.slice(start, start + TASKS_PER_PAGE);

  return (
    <>
      <p className="course-eyebrow">
        Сторінка {page + 1} з {pageCount} (завдання {start + 1}–{Math.min(start + TASKS_PER_PAGE, tasks.length)} з {tasks.length})
      </p>
      <ol className="course-exercise-list">
        {visible.map((t) => (
          <TaskCard key={t.id} task={t} subjectId={subjectId} topicId={topicId} textbook={textbook} onFocusTarget={onFocusTarget} />
        ))}
      </ol>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          ← Назад
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40"
        >
          Далі →
        </button>
      </div>
    </>
  );
}

export function LiteratureV2LessonScreen({ lesson, packageLessons }: { lesson: LiteratureV2LessonView; packageLessons: LiteratureV2LessonListItem[] }) {
  const chatRef = useRef<LessonTopicChatHandle>(null);
  const [screenIndex, setScreenIndex] = useState(0);
  const [chatTarget, setChatTarget] = useState<VoiceTarget | undefined>(() => lesson.screens[0]
    ? { kind: "course", refTable: "literature_v2_screens", refId: lesson.screens[0].id }
    : lesson.tasks[0] ? { kind: "course", refTable: "literature_v2_tasks", refId: lesson.tasks[0].id } : undefined);
  function changeScreenIndex(index: number) {
    setScreenIndex(index);
    const screen = lesson.screens[index];
    if (screen) setChatTarget({ kind: "course", refTable: "literature_v2_screens", refId: screen.id });
  }
  const { voiceMode, autoAdvance, changeVoiceMode, changeAutoAdvance } = useVoiceModeControls("literatureV2");

  const textbook: TextbookRef | null = lesson.textbookMaterialId
    ? { materialId: lesson.textbookMaterialId, title: lesson.textbookTitle ?? lesson.packageTitle, pageCount: lesson.textbookPageCount }
    : null;

  return (
    <article className={`course-lesson ${STEP_NAV_BAR_SPACER_CLASS}`}>
      <LessonNavBar
        subjectId={lesson.subjectId}
        courseNav={{ basePath: "/literature-course-v2", currentLessonId: lesson.id, lessons: packageLessons, topicId: lesson.topicId }}
        extraControls={
          <>
            <VoiceModeToggle voiceMode={voiceMode} onChange={changeVoiceMode} />
            <AutoAdvanceToggle autoAdvance={autoAdvance} voiceMode={voiceMode} onChange={changeAutoAdvance} />
          </>
        }
      />
      <header>
        <p className="course-eyebrow">{lesson.packageTitle}</p>
        <h1>{lesson.title}</h1>
        {lesson.printedPageFrom != null && (
          <p className="course-pages">
            Підручник: с. {lesson.printedPageFrom}
            {lesson.printedPageTo != null && lesson.printedPageTo !== lesson.printedPageFrom ? `–${lesson.printedPageTo}` : ""}
          </p>
        )}
        {lesson.status === "needs_review" && <p className="course-warning">Цей урок ще потребує перевірки дорослого.</p>}
      </header>

      {lesson.objectives.length > 0 && (
        <section>
          <h2>Чого навчимось</h2>
          <ul>
            {lesson.objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      )}

      {lesson.definitions.length > 0 && (
        <section>
          <h2>Поняття</h2>
          <ul>
            {lesson.definitions.map((d, i) => (
              <li key={i}>
                <span className="font-bold">{d.term}</span> — <MathText text={d.explanation.display} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <ScreenNav lesson={lesson} voiceMode={voiceMode} autoAdvance={autoAdvance} index={screenIndex} onIndexChange={changeScreenIndex} />

      {lesson.topicId && <LessonTopicChat ref={chatRef} subjectId={lesson.subjectId} topicId={lesson.topicId} target={chatTarget} />}

      {lesson.tasks.length > 0 && (
        <section>
          <h2>Завдання</h2>
          <TaskList tasks={lesson.tasks} subjectId={lesson.subjectId} topicId={lesson.topicId} textbook={textbook} onFocusTarget={setChatTarget} />
        </section>
      )}
    </article>
  );
}
