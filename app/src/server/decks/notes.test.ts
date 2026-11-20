import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import { speakerNotes } from "./notes";

describe("speaker notes", () => {
  it("follows the presentation order through both relationship files and omits footer placeholders", () => {
    const xml = {
      "ppt/presentation.xml": '<p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst>',
      "ppt/_rels/presentation.xml.rels": '<Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide8.xml"/>',
      "ppt/slides/_rels/slide8.xml.rels": '<Relationship Id="note" Type="presentation/notesSlide" Target="../notesSlides/notesSlide4.xml"/>',
      "ppt/notesSlides/notesSlide4.xml": '<p:sp><p:ph type="sldNum"/><a:p><a:t>8</a:t></a:p></p:sp><p:sp><p:ph type="body"/><a:p><a:t>Карта &amp; легенда</a:t></a:p></p:sp>',
    };
    const bytes = zipSync(Object.fromEntries(Object.entries(xml).map(([k,v]) => [k,strToU8(v)])));
    expect(speakerNotes(bytes)).toEqual(["Карта & легенда",""]);
  });
});
