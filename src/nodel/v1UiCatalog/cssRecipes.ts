// SPDX-License-Identifier: MPL-2.0
// Derived from https://github.com/museumsvictoria/nodel at revision 19756071383d696682688ab436c77c0a1f80c783.
import { type V1UiCssRecipe } from "./shared.js";

export const V1_UI_CSS_RECIPES = [
  {
    name: "fixed-cover-background-overlay",
    title: "Fixed Cover Background Plus Overlay",
    components: ["pages", "row"],
    description: "Adds a full-screen background image and a readable translucent panel scoped by a row class.",
    markup: `<pages title="Room" css="css/custom.css?v=20260717">
  <page title="Main">
    <row class="hero-overlay">
      <column sm="12">...</column>
    </row>
  </page>
</pages>`,
    css: `body {
  background: #111 url('../img/background.jpg?v=20260717') center center / cover fixed no-repeat;
}

.hero-overlay {
  min-height: calc(100vh - 140px);
  padding: 24px;
  background: rgba(0, 0, 0, 0.52);
  border-radius: 12px;
}`,
    notes: ["Scope visible panel styling through row class because page and column XML class do not propagate."],
  },
  {
    name: "scoped-row-section",
    title: "Page/Section Scoping Through Propagated Row Class",
    components: ["row", "column", "group"],
    description: "Targets a specific dashboard section without relying on ignored page/column/group class attributes.",
    markup: `<row class="source-section">
  <column sm="6"><group>...</group></column>
</row>`,
    css: `.source-section .well {
  border-color: rgba(255, 255, 255, 0.25);
}

.source-section .btn {
  min-height: 56px;
}`,
    notes: ["row class is copied to div.row; group class is ignored, so target .source-section .well instead."],
  },
  {
    name: "compact-subtitle-meter-range",
    title: "Compact Subtitle/Meter/Range Layout",
    components: ["subtitle", "meter", "range", "row"],
    description: "Creates a dense control strip for a label, meter, and slider.",
    markup: `<row class="compact-level">
  <column sm="3"><subtitle>Level</subtitle></column>
  <column sm="3"><meter event="Level" type="horizontal"/></column>
  <column sm="6"><range join="Level" min="0" max="100" step="1"/></column>
</row>`,
    css: `.compact-level h5 {
  margin-top: 7px;
}

.compact-level .meter {
  margin-bottom: 0;
}

.compact-level .range form {
  margin-top: 2px;
}`,
    notes: ["meter class is generated but XML class on meter is ignored; scope through the row."],
  },
  {
    name: "meter-number-reposition",
    title: "Reposition Meter Numeric Label",
    components: ["meter", "row"],
    description: "Moves the generated meter p without changing meter markup.",
    markup: `<row class="meter-readout-left"><column sm="12"><meter event="AudioLevel" type="horizontal"/></column></row>`,
    css: `.meter-readout-left .meter[data-type='horizontal'] {
  margin-right: 10px;
}

.meter-readout-left .meter[data-type='horizontal'] p {
  right: auto;
  left: 8px;
  top: 5px;
}`,
    notes: ["The built-in horizontal meter positions p at right:-35px and reserves margin-right:40px."],
  },
  {
    name: "large-switch",
    title: "Enlarge A Switch Without Changing Point Behavior",
    components: ["switch", "row"],
    description: "Increases switch hit target size by styling generated buttons only.",
    markup: `<row class="large-power"><column sm="12"><switch join="Power"/></column></row>`,
    css: `.large-power .btn-switch > .btn {
  min-width: 112px;
  min-height: 64px;
  font-size: 22px;
  line-height: 48px;
}`,
    notes: ["Do not alter data-arg=false/true or data-arg-action; those drive boolean behavior."],
  },
  {
    name: "cache-busted-assets",
    title: "Cache-Bust Custom CSS/JS Paths",
    components: ["pages", "image"],
    description: "Uses query suffixes on browser-facing paths so clients fetch fresh assets after updates.",
    markup: `<pages title="Room" css="css/custom.css?v=20260717" js="js/custom.js?v=20260717" logo="img/logo.png?v=20260717">
  <page title="Main"><row><column><image source="img/photo.jpg?v=20260717"/></column></row></page>
</pages>`,
    notes: [
      "Store files under content/, but reference them without the content/ prefix. Asset validators should strip query/hash before matching files.",
    ],
  },
] as const satisfies readonly V1UiCssRecipe[];
