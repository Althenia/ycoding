# Account usage provider marks

These transparent local vectors identify the twelve built-in account usage adapters in `packages/core/src/provider-usage.ts`. Unknown provider IDs have no mark. Consumers retain the visible provider/account name and distinguish API billing from subscription quotas.

No backgrounds, app tiles, borders, shadows or raster backplates are included. Supplied colored paths retain their original colors. Neutral LobeHub vectors explicitly use `currentColor`; CSS uses their alpha geometry as a mask with semantic text ink for light/dark readability. This paints only the original glyph, not a backing shape. Cursor uses its two supplied transparent 2D cube originals without filtering or recoloring. No alpha extraction, redrawing or synthetic color variant is used.

## Sources and attribution

| File | Provider IDs | Source asset | Treatment |
| --- | --- | --- | --- |
| `claude.svg` | `anthropic` | [LobeHub Claude color](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/claude-color.svg) | Supplied peach Claude product star (`#D97757`) for the Claude subscription adapter, not the Anthropic corporate wordmark. |
| `openrouter.svg` | `openrouter` | [LobeHub OpenRouter color](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/openrouter-color.svg) | Supplied lime glyph (`#C8FF00`), without the official app icon's dark tile. |
| `openai.svg` | `openai` | [LobeHub OpenAI](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/openai.svg) | Transparent OpenAI knot; no ChatGPT app tile or invented green tint. The adapter covers ChatGPT/Codex and API usage; the mark does not merge those account types. |
| `meta.svg` | `meta`, `muse` | [LobeHub Meta color](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/meta-color.svg) | Supplied blue corporate infinity mark. Meta API billing/usage has no inferred quota limit. Muse is the Meta subscription integration; this shared parent-company mark is not a dedicated Muse product logo. |
| `github-copilot.svg` | `github-copilot` | [LobeHub GitHub Copilot](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/githubcopilot.svg) | Transparent GitHub Copilot robot/goggles, not Microsoft's separate Copilot ribbon and not its white circular app backplate. |
| `grok.svg` | `xai` | [LobeHub Grok](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/grok.svg) | Grok product glyph for the Grok/SuperGrok subscription adapter, not the corporate xAI wordmark. |
| `zai.svg` | `zai`, `zai-coding-plan` | [LobeHub Z.AI](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/zai.svg) | Shared transparent Z.AI glyph; provider/account identities stay separate. No app backplate or fabricated color edition. |
| `opencode.svg` | `opencode-go` | [LobeHub OpenCode](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/opencode.svg) | Shared transparent OpenCode terminal mark for Go, not a dedicated Go logo. Local-spend-only OpenCode Zen (`opencode`) has no mapping. |
| `antigravity.svg` | `antigravity` | [LobeHub Antigravity color](https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/antigravity-color.svg) | Supplied colored Antigravity glyph for the Google subscription adapter, not the Gemini sparkle or Google corporate mark. |
| `cursor-light.svg`, `cursor-dark.svg` | `cursor` | [Cursor brand resources](https://cursor.com/en-US/brand), [official asset archive](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip) | Exact `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` for light surfaces (`#26251e`) and `CUBE_2D_DARK.svg` for dark surfaces (`#edecec`). No favicon tile or 3D edition. |

LobeHub source files are unmodified, except for their descriptive local filenames. The complete MIT notice is retained in `LICENSE.lobehub`. Collection source: [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons). Trademark rights remain with each brand owner; the collection license does not transfer them.

Cursor files are unmodified originals from the brand owner's downloadable archive. No open copyright license is asserted for those official assets; Cursor's brand and trademark rights remain with its owner. Use the originals within the owner's applicable brand terms. No general permission to modify or redistribute brand identities is implied by this inventory.
