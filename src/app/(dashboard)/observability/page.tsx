import { redirect } from 'next/navigation'

// The overview arrives with the telemetry dashboard (spec 0042 FR10).
export default function ObservabilityPage() {
  redirect('/observability/logs')
}
