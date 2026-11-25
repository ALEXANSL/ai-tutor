---
name: lesson-visual-style
description: House visual style for AI-Tutor lessons. Use whenever you design, generate or review anything a child sees in a lesson - slides, narrated decks, illustrations, diagrams, lesson screens, Studio designer prompts (app/prompts/studio.md, lesson_generation.md) or image-generation prompts - and before using the nano-banana skill in this repo.
---

# Lesson visual style (AI-Tutor)

The child is a 6th-grade student (about 11-12 years old) learning the Ukrainian NUSh curriculum on a tablet. The format that works best is a **narrated presentation**: one idea per slide, a short voice-over, and a visual that explains instead of decorating.

Sources of truth, read them before changing anything visual:
- `docs/04-design-system.md` - tokens, typography, accessibility, animation rules.
- `app/prompts/studio.md` - contract of the Studio author, designer and reviewer.
- `app/src/server/studio/image-provider.ts` - the image models the app really calls.

If this skill and those documents disagree, the documents win. Update the document first, then code (CLAUDE.md rule).

## 1. Pick the visual type per slide

Every slide gets exactly one main visual, chosen by what it must explain:

| Content of the slide | Visual | How it is made |
| --- | --- | --- |
| Numbers, fractions, geometry, units, graphs, timelines, cycles, cause and effect, classification | Diagram | Code: the controlled SVG renderer of the Studio designer. Never an image model. |
| A scene, a character, an epoch, a place, a mood (literature, history, intro hook) | Illustration | Image model, see section 3 |
| A process that moves (eruption, water cycle, mechanism) | Short video or a 3-5 step diagram sequence | Prefer the diagram sequence; video only when the cost estimate allows it |
| A rule, a definition, a formula | Text card | HTML text in the app, formulas with KaTeX |
| Practice | Interactive component | Existing components (`number_line` and the ADR-020 set) |

No visual at all is better than a decorative one. A diagram must be checkable by the reviewer: correct numbers, units, labels, order.

## 2. Slide layout rules

- One idea per slide. At most 3 short bullets, at most about 62 characters per line.
- Slide text in the app is at least 19px (Body-lg, Nunito); never below 17px.
- Colors only from the design-system tokens. Child UI: `--primary #FF7A50` (coral), `--secondary #2EC4B6` (teal), `--accent-voice #7C6CF0` (lilac), background `--bg #FAF6EF`, surface `#FFFFFF`, text `#2B2A28`. `--danger` is reserved for the alarm button, never for lesson content.
- Meaning is never carried by color alone: add an icon, shape or word (design system 1.4).
- Both light and dark themes must work. A generated illustration sits on a neutral card so it reads in both.
- Animations 150-250 ms, no looping decoration, respect `prefers-reduced-motion`.
- The narration says more than the slide shows; the slide does not repeat the narration word for word.
- Every image has a short Ukrainian alt text; every audio has a text alternative.

## 3. Generated illustrations

1. **No text inside generated images.** Image models often distort Ukrainian (Cyrillic) letters. Labels, captions, numbers and formulas are rendered by the app on top of or under the image. Add to every prompt: `no text, no letters, no numbers, no captions, no watermark`.
2. **One style per lesson.** Use the same style block in every prompt of one lesson, and pass the first approved image as a reference for the rest when the model supports it. Default style block:
   `Friendly flat vector illustration for a 12-year-old student, soft rounded shapes, warm cream background (#FAF6EF), coral (#FF7A50), teal (#2EC4B6) and lilac (#7C6CF0) accents, clean composition with one clear subject, calm and not scary, historically and scientifically accurate details.`
3. **Accuracy beats beauty.** Historical clothing, animals, plants, maps and scientific objects must be correct for the topic. If you are not sure the model can draw it correctly, use a diagram instead.
4. **Safe for a child.** No violence, gore, horror, weapons in focus, or frightening faces, even for war or disaster topics; show them through maps, symbols and consequences.
5. **The tutor character** is the original glowing ball ("вогник") from design system section 0. Never draw it as a human, and never copy known characters, brands or the style of a specific existing game, cartoon or artist.
6. **Cheapest model that is good enough.** Use the models in `image-provider.ts`. Prefer 1K resolution. For bulk weekly preparation prefer batch mode when the code supports it. Any new model, provider or larger volume needs the architect to update `docs/03-resources-and-costs.md` and Alex's approval first.

## 4. Privacy and keys (non-negotiable)

- Never put the child's name, photo, school, class or any personal detail into a prompt.
- Only paid API keys without training on data. Do not use the Gemini free tier.
- Keys live only in `.env.local` or hosting / environment secrets. Never ask for a key in chat and never write it into a file in git. Never pass a key on the command line in a way that ends up in logs or commits.
- All AI calls from the app run on the server only.

## 5. Using the nano-banana skill in this repo

`.agents/skills/nano-banana` (third-party, EvoScientist) turns a slide plan into slide images with Gemini and packs them into PPTX. In this project use it only:
- for **prototypes and reference decks** that show Alex and the designer what a good lesson can look like, and
- for **text-free illustrations**, with the rules of section 3.

Do not ship its full-slide images (text baked into the picture) to the child: Ukrainian text in images is unreliable and cannot be reviewed or edited. Its "Vector Illustration" style is the closest to ours; override its colors with the tokens above. Its `--provider atlas` option sends data to another provider; do not use it. It runs only where a paid `GOOGLE_API_KEY` / `GEMINI_API_KEY` is already set in the environment; if there is none, stop and tell the orchestrator instead of asking for the key.

## 6. Self-check before handing over

- [ ] Each slide: one idea, one visual of the right type (section 1).
- [ ] No text inside generated images; all labels are app text.
- [ ] Colors and type sizes from `docs/04-design-system.md`; light and dark both readable.
- [ ] Diagrams factually correct (numbers, units, order) and checkable.
- [ ] Nothing frightening; no personal data in prompts; cost within the approved estimate.
