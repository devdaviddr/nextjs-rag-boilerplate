/**
 * The "model is working" indicator: three dots rising in sequence.
 *
 * Shown from submit until the first token arrives — after that the streamed
 * text is itself the progress indicator, so keeping the dots would be noise.
 * `role="status"` announces it once to a screen reader rather than on every
 * animation frame.
 */
export function Thinking() {
  return (
    <div
      role="status"
      aria-label="Thinking"
      className="text-muted-foreground flex items-center gap-1 py-1"
    >
      <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
      <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
      <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
      <span className="sr-only">Thinking…</span>
    </div>
  )
}
