// 270° gauge arc, generalized from the FX AmountRing. amount is 0..1.
export function Ring({ amount, size = 44 }: { amount: number; size?: number }) {
  const r = size / 2 - 3
  const c = 2 * Math.PI * r
  const arc = c * 0.75
  const fill = arc * Math.min(1, Math.max(0, amount))
  const mid = size / 2
  return (
    <svg className="dial-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g transform={`rotate(135 ${mid} ${mid})`}>
        <circle cx={mid} cy={mid} r={r} className="dial-ring-track" strokeDasharray={`${arc} ${c}`} />
        <circle cx={mid} cy={mid} r={r} className="dial-ring-fill" strokeDasharray={`${fill} ${c}`} />
      </g>
    </svg>
  )
}
