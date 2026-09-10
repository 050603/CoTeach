/** Shared Praxis → PrAIxis wordmark animation used by the homepage and auth pages. */
export function PraixisOriginWord({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`praixis-origin__word ${className}`.trim()}
    >
      <span>Pr</span>
      <span className="praixis-origin__mutable">
        <span className="praixis-origin__a">a</span>
        <span className="praixis-origin__ai">AI</span>
      </span>
      <span>xis</span>
    </div>
  );
}
