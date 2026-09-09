/** Small, code-native course artwork; no network request or decorative animation. */
export function LearningArt({ className = "", variant = 0 }: { className?: string; variant?: number }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 360 240" fill="none" className={`pbl-learning-art ${className}`}>
    <ellipse cx="186" cy="210" rx="126" ry="13" fill="currentColor" opacity=".06" />
    <path d="M42 161C5 59 93 7 176 44S348 44 319 150C300 214 224 227 185 196" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.5" strokeDasharray="4 7" />
    <circle cx="281" cy="45" r="20" fill="#EAB779" />
    <circle cx="281" cy="45" r="10" stroke="#FFF8E9" strokeWidth="1.5" />
    <g transform={`rotate(${variant % 2 ? 9 : -8} 180 125)`}>
      <rect x="87" y="58" width="182" height="144" rx="16" fill="currentColor" opacity=".12" />
      <rect x="76" y="44" width="182" height="144" rx="16" fill="#FCFDFF" stroke="#D8E4F0" />
      <path d="M76 80H258" stroke="#E4EBF2" />
      <circle cx="94" cy="62" r="3" fill="#D8E4F0" /><circle cx="105" cy="62" r="3" fill="#D8E4F0" /><circle cx="116" cy="62" r="3" fill="#D8E4F0" />
      <rect x="94" y="98" width="53" height="66" rx="8" fill="#E5F1ED" />
      <path d="M105 147L118 121L137 147H105Z" fill="#58A596" /><circle cx="130" cy="115" r="6" fill="#EAB779" />
      <path d="M164 106H237M164 119H224M164 139H215M164 152H232" stroke="#CFDAE8" strokeWidth="5" strokeLinecap="round" />
    </g>
    <g transform="rotate(10 274 159)"><rect x="233" y="124" width="76" height="66" rx="13" fill="#4D73D5" /><path d="M251 158L264 171L290 145" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></g>
    <g transform="rotate(-15 57 158)"><rect x="28" y="127" width="59" height="62" rx="12" fill="#74B7A7" /><path d="M42 148H73M42 158H65M42 168H57" stroke="#F2FCF8" strokeWidth="3" strokeLinecap="round" /></g>
    <path d="M215 20V30M210 25H220M327 103V113M322 108H332" stroke="currentColor" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
