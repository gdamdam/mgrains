// "mgrains" rendered as a dot-matrix wordmark — a crisp inline SVG dot grid so
// the logo is font-independent and scales cleanly (mirrors the braille/dot-matrix
// sketch). Each glyph is a uniform 5-row bitmap; every set cell becomes a dot.

// 1 = dot, 0 = empty. Uniform 5 rows tall; widths vary per letter.
const GLYPHS: Record<string, string[]> = {
  m: ['11111', '10101', '10101', '10101', '10101'],
  g: ['1111', '1001', '1111', '0001', '1110'],
  r: ['111', '101', '100', '100', '100'],
  a: ['1110', '0001', '1111', '1001', '1111'],
  i: ['1', '0', '1', '1', '1'],
  n: ['1110', '1001', '1001', '1001', '1001'],
  s: ['1111', '1000', '1110', '0001', '1111'],
}

const WORD = 'mgrains'
const ROWS = 5
const LETTER_GAP = 1 // empty columns between glyphs
const DOT_RADIUS = 0.42 // in cell units; < 0.5 leaves a gap between dots

export function Wordmark({ height = 26 }: { height?: number }): React.ReactElement {
  const dots: { c: number; r: number }[] = []
  let col = 0
  for (const char of WORD) {
    const rows = GLYPHS[char]
    const width = rows[0].length
    for (let r = 0; r < rows.length; r += 1) {
      for (let c = 0; c < width; c += 1) {
        if (rows[r][c] === '1') dots.push({ c: col + c, r })
      }
    }
    col += width + LETTER_GAP
  }
  const totalCols = col - LETTER_GAP
  const aspect = totalCols / ROWS

  return (
    <svg
      className="wordmark"
      width={Math.round(height * aspect)}
      height={height}
      viewBox={`0 0 ${totalCols} ${ROWS}`}
      role="img"
      aria-label="mgrains"
      fill="currentColor"
    >
      {dots.map((dot) => (
        <circle key={`${dot.c}-${dot.r}`} cx={dot.c + 0.5} cy={dot.r + 0.5} r={DOT_RADIUS} />
      ))}
    </svg>
  )
}
