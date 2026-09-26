/**
 * NFR-SAFE-4, US-12.1 КП-2: for `severity: "urgent"` the reply the child sees
 * is **always** this exact, deterministic sentence — never the tutor/friend/
 * answer-evaluation model's own text, whatever it generated. This is checked
 * in CODE (this constant, used verbatim by every caller below), not left to
 * a prompt instruction a model could "forget" (ADR-009).
 *
 * Single source of truth for all three places a child's free-text reply is
 * moderated: `chat.ts` (`askTopicChat`), `friendChat.ts` (`askFriendChat`)
 * and `orchestrator.ts` (`submitStepAnswer`, lesson open-question answers —
 * BUG-013: this one was missing the override entirely).
 */
export const URGENT_REPLY_UK =
  "Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.";
