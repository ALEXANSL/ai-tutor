/** Public voice protocol: identifiers only; lesson text and keys stay server-side. */
export type VoiceTarget =
  | { kind: "chapter"; lessonId: string; stepId: string }
  | { kind: "lesson"; source: "session"; sessionId: string; stepId: string }
  | { kind: "course"; refTable: string; refId: string };
export interface VoiceTurn {
  text: string;
  message: { id: string; author: "child" | "ai" | "system" | "parent"; content: string; createdAt: string };
  audio: { audioBase64: string; mimeType: string } | null;
  endConversation?: boolean;
}
