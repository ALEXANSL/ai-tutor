"use client";
import { useState } from "react";
import { VoiceConversation } from "./VoiceConversation";
import { MathText } from "@/components/shared/MathText";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";

export function LessonVoicePanel(props: { target: VoiceTarget; onActiveChange?: (active: boolean) => void }) {
  return <LessonVoiceSession key={JSON.stringify(props.target)} {...props} />;
}
function LessonVoiceSession({ target, onActiveChange }: { target: VoiceTarget; onActiveChange?: (active: boolean) => void }) {
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  return <div>
    <VoiceConversation target={target} onActiveChange={onActiveChange} onTurn={turn => setTurns(previous => [...previous.slice(-7), turn])} />
    {turns.length > 0 && <div className="mb-3 max-h-80 space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-3.5" aria-label="Текст голосової розмови" aria-live="polite">
      {turns.map(turn => <div key={turn.message.id}>
        <p className="mb-1 text-sm"><strong>Ти:</strong> {turn.text}</p>
        <div className="text-sm"><strong>Репетитор:</strong> <MathText text={turn.message.content} /></div>
      </div>)}
    </div>}
  </div>;
}
