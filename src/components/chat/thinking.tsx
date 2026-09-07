/**
 * The "model is working" indicator: three dots rising in sequence.
 *
 * Shown from submit until the first token arrives — after that the streamed
 * text is itself the progress indicator, so keeping the dots would be noise.
 * `role="status"` announces it once to a screen reader rather than on every
 * animation frame.
 *
 * With the agentic path enabled (spec 0029) the gap before the first token can
 * run to several seconds across several searches, so a `label` names the phase.
 * Bare dots for that long read as "stuck" rather than "working".
 */
export function Thinking({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label ?? 'Thinking'}
      className="text-muted-foreground flex items-center gap-2 py-1"
    >
      <span className="flex items-center gap-1">
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
        <span className="thinking-dot inline-block size-1.5 rounded-full bg-current" />
      </span>
      {label && <span className="text-xs">{label}</span>}
      <span className="sr-only">{label ?? 'Thinking…'}</span>
    </div>
  )
}
