import { SyntaxStyle } from "@opentui/core"
import { readableForeground } from "./component"
import type { ResolvedThemeView } from "./types"

export type SyntaxTheme = Pick<ResolvedThemeView, "syntax" | "markdown"> & {
  hue: { accent: Pick<ResolvedThemeView["hue"]["accent"], 200 | 800> }
  categorical: readonly Pick<ResolvedThemeView["hue"]["accent"], 200 | 800>[]
  text: {
    default: ResolvedThemeView["text"]["default"]
    subdued: ResolvedThemeView["text"]["subdued"]
    action: { primary: { focused: ResolvedThemeView["text"]["default"] } }
    feedback: Record<"error" | "warning" | "success" | "info", { default: ResolvedThemeView["text"]["default"] }>
  }
  background: { default: ResolvedThemeView["background"]["default"] }
  diff: {
    text: Pick<ResolvedThemeView["diff"]["text"], "added" | "removed" | "context">
    background: ResolvedThemeView["diff"]["background"]
  }
}

export function generateSyntax(theme: SyntaxTheme, mode: "dark" | "light") {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme, mode))
}

function getSyntaxRules(theme: SyntaxTheme, mode: "dark" | "light") {
  const accent = theme.hue.accent[mode === "light" ? 800 : 200]
  const warning = theme.text.feedback.warning.default
  return [
    {
      scope: ["default"],
      style: {
        foreground: theme.text.default,
      },
    },
    {
      scope: ["prompt"],
      style: {
        foreground: accent,
      },
    },
    {
      scope: ["extmark.file"],
      style: {
        foreground: warning,
        bold: true,
      },
    },
    {
      scope: ["extmark.agent"],
      style: {
        foreground: theme.categorical[0][mode === "light" ? 800 : 200],
        bold: true,
      },
    },
    {
      scope: ["extmark.skill"],
      style: {
        foreground: accent,
        bold: true,
      },
    },
    {
      scope: ["extmark.paste"],
      style: {
        foreground: readableForeground(theme.text.action.primary.focused, warning),
        background: warning,
        bold: true,
      },
    },
    {
      scope: ["comment"],
      style: {
        foreground: theme.syntax.comment,
        italic: true,
      },
    },
    {
      scope: ["comment.documentation"],
      style: {
        foreground: theme.syntax.comment,
        italic: true,
      },
    },
    {
      scope: ["string", "symbol"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["number", "boolean"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["character.special"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.type"],
      style: {
        foreground: theme.syntax.type,
        bold: true,
        italic: true,
      },
    },
    {
      scope: ["keyword.function", "function.method"],
      style: {
        foreground: theme.syntax.function,
      },
    },
    {
      scope: ["keyword"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.import"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["keyword.conditional.ternary"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: {
        foreground: theme.syntax.function,
      },
    },
    {
      scope: ["type", "module"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["constant"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["property"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["class"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["parameter"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: {
        foreground: theme.syntax.punctuation,
      },
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin"],
      style: {
        foreground: theme.text.feedback.error.default,
      },
    },
    {
      scope: ["variable.super"],
      style: {
        foreground: theme.text.feedback.error.default,
      },
    },
    {
      scope: ["string.escape", "string.regexp"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["keyword.directive"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["punctuation.special"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["keyword.modifier"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.exception"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    // Markdown specific styles
    {
      scope: ["markup.heading"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.1"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
        underline: true,
      },
    },
    {
      scope: ["markup.heading.2"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.3"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.4"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.5"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.6"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: {
        foreground: theme.markdown.strong,
        bold: true,
      },
    },
    {
      scope: ["markup.italic"],
      style: {
        foreground: theme.markdown.emphasis,
        italic: true,
      },
    },
    {
      scope: ["markup.list"],
      style: {
        foreground: theme.markdown.listItem,
      },
    },
    {
      scope: ["markup.quote"],
      style: {
        foreground: theme.markdown.blockQuote,
        italic: true,
      },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.markdown.code,
      },
    },
    {
      scope: ["markup.raw.inline"],
      style: {
        foreground: theme.markdown.code,
        background: theme.background.default,
      },
    },
    {
      scope: ["markup.link"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["markup.link.label"],
      style: {
        foreground: theme.markdown.linkText,
        underline: true,
      },
    },
    {
      scope: ["markup.link.url"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["label"],
      style: {
        foreground: theme.markdown.linkText,
      },
    },
    {
      scope: ["spell", "nospell"],
      style: {
        foreground: theme.text.default,
      },
    },
    // Additional common highlight groups
    {
      scope: ["string.special", "string.special.url"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["character"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["float"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["comment.error"],
      style: {
        foreground: theme.text.feedback.error.default,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.warning"],
      style: {
        foreground: warning,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.todo", "comment.note"],
      style: {
        foreground: theme.text.feedback.info.default,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["namespace"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["field"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["type.definition"],
      style: {
        foreground: theme.syntax.type,
        bold: true,
      },
    },
    {
      scope: ["keyword.export"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["attribute", "annotation"],
      style: {
        foreground: warning,
      },
    },
    {
      scope: ["tag"],
      style: {
        foreground: theme.text.feedback.error.default,
      },
    },
    {
      scope: ["tag.attribute"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["tag.delimiter"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["markup.strikethrough"],
      style: {
        foreground: theme.text.subdued,
      },
    },
    {
      scope: ["markup.underline"],
      style: {
        foreground: theme.text.default,
        underline: true,
      },
    },
    {
      scope: ["markup.list.checked"],
      style: {
        foreground: theme.text.feedback.success.default,
      },
    },
    {
      scope: ["markup.list.unchecked"],
      style: {
        foreground: theme.text.subdued,
      },
    },
    {
      scope: ["diff.plus"],
      style: {
        foreground: theme.diff.text.added,
        background: theme.diff.background.added,
      },
    },
    {
      scope: ["diff.minus"],
      style: {
        foreground: theme.diff.text.removed,
        background: theme.diff.background.removed,
      },
    },
    {
      scope: ["diff.delta"],
      style: {
        foreground: theme.diff.text.context,
        background: theme.diff.background.context,
      },
    },
    {
      scope: ["error"],
      style: {
        foreground: theme.text.feedback.error.default,
        bold: true,
      },
    },
    {
      scope: ["warning"],
      style: {
        foreground: warning,
        bold: true,
      },
    },
    {
      scope: ["info"],
      style: {
        foreground: theme.text.feedback.info.default,
      },
    },
    {
      scope: ["debug"],
      style: {
        foreground: theme.text.subdued,
      },
    },
  ]
}
