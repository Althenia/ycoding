export function speechAccuracy(reference: string, hypothesis: string) {
  const expected = Array.from(reference.normalize("NFC")).filter((character) => /[\u0e00-\u0e7f]/u.test(character))
  const actual = Array.from(hypothesis.normalize("NFC")).filter((character) => /[\u0e00-\u0e7f]/u.test(character))
  if (expected.length > 20000 || actual.length > 20000) throw new Error("Accuracy input exceeds the character limit")
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index)
  expected.forEach((character, index) => {
    const current = [index + 1]
    actual.forEach((candidate, column) => {
      current.push(
        Math.min(current[column] + 1, previous[column + 1] + 1, previous[column] + Number(character !== candidate)),
      )
    })
    previous = current
  })
  const terms = [
    ...new Set(
      (reference.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? [])
        .filter((term) => /[A-Za-z]/.test(term))
        .map((term) => term.replace(/[._-]+$/, "")),
    ),
  ]
  const preserved = terms.filter((term) =>
    new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(hypothesis),
  )
  return {
    thaiCharacters: expected.length,
    thaiEdits: previous[actual.length],
    thaiCER: expected.length ? previous[actual.length] / expected.length : null,
    technicalTerms: terms,
    preservedTerms: preserved,
    technicalTermRecall: terms.length ? preserved.length / terms.length : null,
  }
}
