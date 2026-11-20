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
  slides: DeckSlide[];
  state: "processing" | "ready" | "error";
  published: boolean;
  revision: number;
  audioLookupRecovered?: boolean;
  error: string;
}
