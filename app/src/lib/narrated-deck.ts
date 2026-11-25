import type { LessonSlidePlan } from "./lesson-slide-plan";
export interface DeckSlide {
  notes: string;
  narration: string;
  ready: boolean;
}
export interface NarratedDeck {
  title: string;
  subjectId: string;
  topicId?: string | null;
  driveId: string;
  generated?: { href: string; wishes: string; sourceHash?: string; plan?: LessonSlidePlan; pptxBucket?: "lesson-presentations"; pptxReady?: boolean };
  slides: DeckSlide[];
  state: "processing" | "ready" | "error";
  published: boolean;
  revision: number;
  retry?: { failures: number; reason: string; at: string } | null;
  retryPolicyVersion?: number;
  audioLookupRecovered?: boolean;
  error: string;
}
