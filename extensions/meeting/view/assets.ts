/// <reference path="./assets.d.ts" />

import html from "./index.html" with { type: "text" }
import css from "./style.css" with { type: "text" }
import script from "./app.js" with { type: "text" }
import model from "./model.js" with { type: "text" }
import fonts from "./fonts.css" with { type: "text" }
import mark from "../../../assets/brand/ycoding-mark.svg" with { type: "text" }

if (typeof html !== "string") throw new Error("Meeting page requires the text import loader")

export const viewAssets = new Map([
  ["/view", { type: "text/html; charset=utf-8", body: html }],
  ["/view/style.css", { type: "text/css; charset=utf-8", body: `${fonts}\n${css}` }],
  ["/view/app.js", { type: "text/javascript; charset=utf-8", body: script }],
  ["/view/model.js", { type: "text/javascript; charset=utf-8", body: model }],
  ["/view/mark.svg", { type: "image/svg+xml", body: mark }],
])

export const viewPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
