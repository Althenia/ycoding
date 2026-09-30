# Geist typography assets

YCoding uses Geist Sans (`Geist`) and Geist Mono from the official
[Geist v1.7.2 release](https://github.com/vercel/geist-font/releases/tag/v1.7.2).
The font binaries are unmodified. Each family supplies normal and italic variable
faces with a `wght` range of 100–900. `OFL.txt` contains the upstream copyright and
SIL Open Font License 1.1.

| Repository file | Member in `geist-font-v1.7.2.zip` |
| --- | --- |
| `Geist.woff2` | `geist-font/Geist/webfonts/Geist[wght].woff2` |
| `Geist-Italic.woff2` | `geist-font/Geist/webfonts/Geist-Italic[wght].woff2` |
| `GeistMono.woff2` | `geist-font/GeistMono/webfonts/GeistMono[wght].woff2` |
| `GeistMono-Italic.woff2` | `geist-font/GeistMono/webfonts/GeistMono-Italic[wght].woff2` |
| `OFL.txt` | `geist-font/OFL.txt` |

To refresh these vendored files, download the named release archive, verify its
SHA-256 against the upstream release digest, and copy only the listed members to
their repository filenames. Trim trailing whitespace from license lines without
changing its text; do not edit or subset the font binaries. The v1.7.2 archive SHA-256 is
`7fc800d2ac6b92844895196e5041aca55d814c15db70c44f79b3b83ab82b04e2`.

Web font URLs are build-owned, same-origin assets. Extension derivatives must use
their owning generation command and remain inside the existing packaged file
list. The terminal's actual font remains a user-controlled host setting; desktop
font formats for manual installation are available in the upstream archive.
