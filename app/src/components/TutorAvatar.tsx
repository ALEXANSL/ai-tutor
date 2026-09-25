import { uk } from "@/i18n/uk";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "paused";

const SIZES = { sm: "h-11 w-11 text-xl", md: "h-20 w-20 text-3xl", lg: "h-24 w-24 text-4xl" } as const;

/**
 * Tutor presenter for the MVP: the "flame" (вогник) — docs/04 §0, §5.1.
 * The "I am AI" badge always sits right next to the avatar (US-1.8 KP-11).
 */
export function TutorAvatar({
  size = "lg",
  state = "idle",
  badge = true,
}: {
  size?: keyof typeof SIZES;
  state?: VoiceState;
  badge?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`tutor-avatar ${SIZES[size]}`} data-state={state} aria-hidden="true">
        <div className="tutor-avatar__ring" />
        <div className="tutor-avatar__core">✦</div>
      </div>
      {badge && <AiBadge />}
    </div>
  );
}

export function AiBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-alt px-3 py-1.5 font-parent text-xs font-bold text-muted">
      ✦ <b className="text-voice">{uk.ai.badge}</b>, {uk.ai.badgeSuffix}
    </span>
  );
}
