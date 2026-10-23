/** Public voice protocol: identifiers only; lesson text and keys stay server-side. */
export type VoiceTarget =
  | { kind: "chapter"; lessonId: string; stepId: string }
  | { kind: "lesson"; source: "session"; sessionId: string; stepId: string }
  | { kind: "course"; refTable: string; refId: string }
  /** US-8.5/S46 "ШІ-друг": free-topic chat, no lesson/subject/topic — but
   * now one of several named chats per child, so the target must say which. */
  | { kind: "friend"; chatId: string };
export interface VoiceTurn {
  text: string;
  message: { id: string; author: "child" | "ai" | "system" | "parent"; content: string; createdAt: string };
  audio: { audioBase64: string; mimeType: string } | null;
  endConversation?: boolean;
  /** Routine authorization expiry must not be presented as an urgent safety event. */
  endReason?: "safety" | "inactive";
}
