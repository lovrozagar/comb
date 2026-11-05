/* The one fold a `_search` column's writer and likeSearch's reader share */

/* a run of the combining marks NFKD splits off a letter (é is e + U+0301), with the letter before it when that letter is Cyrillic */
const MARKS = /(\p{Script=Cyrillic})?([\u0300-\u036f]+)/gu
/* Hebrew points and cantillation, Arabic harakat, the superscript alef and Quranic marks, and the
   tatweel that stretches a word: optional, and not typed (U31) */
const SEMITIC_MARKS = /[\u0591-\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/gu

/**
 * `text` without its combining marks, but those that make a Cyrillic letter of its own (й is и +
 * U+0306, ї is і + U+0308): a mark stays only where NFC puts it back into one letter with the one
 * before it, so a stress mark (а́, which no letter holds) goes, as FTS5's unicode61 drops it (U7)
 */
const unmarked = (text: string): string =>
	text
		.replace(MARKS, (_run, letter: string | undefined, marks: string) =>
			letter === undefined
				? ""
				: letter + [...marks].filter((mark) => [...`${letter}${mark}`.normalize("NFC")].length === 1).join(""),
		)
		.replace(SEMITIC_MARKS, "")

/* the Latin letters NFKD leaves whole, each with the ASCII a reader types for it (ẞ, Æ, … lowercase to these first) */
const LATIN_FOLD: Readonly<Record<string, string>> = {
	ð: "d",
	ß: "ss",
	æ: "ae",
	ø: "o",
	þ: "th",
	đ: "d",
	ħ: "h",
	ı: "i",
	ĸ: "k",
	ł: "l",
	ŋ: "n",
	œ: "oe",
	ŧ: "t",
}
const LATIN_LETTERS = /[ðßæøþđħıĸłŋœŧ]/g

/**
 * The text a `_search` column stores for `parts`, and what likeSearch folds each term to: the
 * present parts joined by a space, compatibility forms folded (ＦＩＬＥ, ﬁ), lowercased, Greek final
 * sigma ς as σ (so a letter folds the same wherever it stands), combining marks removed but those
 * that make a Cyrillic letter (й, ї, ё), the Latin letters with no decomposition spelled in ASCII
 * (ß ss, æ ae, œ oe, ø o, ł l, đ and ð d, þ th, ı i, ĸ k, ŋ n, ŧ t, ħ h), then composed again (NFC),
 * so й and Hangul syllables stay whole. Write the column with it, so the reader and the writer
 * are one function.
 */
function searchText(...parts: Array<string | null | undefined>): string {
	const lowered = parts
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ")
		.normalize("NFKD")
		.toLowerCase()
		/* toLowerCase writes Σ as ς at a word end and σ inside one: one letter, whatever its place */
		.replace(/ς/g, "σ")
	return (
		unmarked(lowered)
			.replace(LATIN_LETTERS, (letter) => LATIN_FOLD[letter] as string)
			/* what kept its marks, and Hangul's jamo, composed back: й, ї and 가 as they were written */
			.normalize("NFC")
	)
}

export { searchText }
