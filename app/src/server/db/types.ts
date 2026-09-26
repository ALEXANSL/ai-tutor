/** Row shapes used by S0 (hand-written until generated types are introduced). */
export interface ChildProfileRow {
  id: string;
  family_id: string;
  app_user_id: string;
  nickname: string | null;
  tutor_name: string | null;
  tutor_name_source: "suggested" | "custom" | null;
  /** Gender implied by the name choice; used only while tutor_voice_id is null (BUG-002). */
  tutor_name_gender: "f" | "m";
  tutor_voice_id: string | null;
  persona_updated_at: string | null;
  onboarding_completed_at: string | null;
  /** Lesson pacing settings (S3, налашт.): US-6.7 КП-1, US-16.4. */
  lesson_minutes: 30 | 45;
  idle_hint_s: number;
  idle_pause_s: number;
  /** US-12.2 КП-1 (налашт.): offer a break after this many continuous minutes. */
  break_after_minutes: number;
}

export interface TutorNameOption {
  name: string;
  hint?: string;
}

export interface TutorNameOptions {
  f: TutorNameOption[];
  m: TutorNameOption[];
}

export interface PersonaEditable {
  name: boolean;
  voice: boolean;
  avatar: boolean;
}

export interface ParentSettingsRow {
  family_id: string;
  pin_hash: string | null;
  pin_updated_at: string | null;
  pin_failed: number;
  pin_locked_until: string | null;
  pin_max_attempts: number;
  pin_lock_minutes: number;
  parent_mode_idle_min: number;
  tutor_name_options: TutorNameOptions;
  persona_child_editable: PersonaEditable;
  telegram_linked_at: string | null;
}

/** US-12.1 (ADR-009): one flagged reply, parent-only (the quote never leaves this row). */
export interface SafetyEventRow {
  id: string;
  family_id: string;
  child_profile_id: string;
  mode: "lesson" | "tutor_chat" | "friend_chat" | "voice" | "tutor_name";
  session_id: string | null;
  chat_id: string | null;
  category: string;
  severity: "normal" | "urgent";
  quote: string;
  model_confidence: number | null;
  created_at: string;
}

export interface OutboundDeliveryRow {
  id: string;
  family_id: string;
  safety_event_id: string | null;
  channel: "email" | "telegram";
  status: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  is_test: boolean;
  created_at: string;
}

export interface SubjectRow {
  id: string;
  code: string;
  name_uk: string;
  active: boolean;
  is_stub: boolean;
  sort_order: number;
  config: { icon?: string; shortNameUk?: string } & Record<string, unknown>;
}

export interface NotificationRow {
  id: string;
  type: string;
  severity: "normal" | "urgent";
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}
