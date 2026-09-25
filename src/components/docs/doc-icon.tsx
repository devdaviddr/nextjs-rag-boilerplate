import {
  Bell,
  BookOpen,
  Database,
  GitBranch,
  GraduationCap,
  HardDriveDownload,
  Info,
  KeyRound,
  type LucideIcon,
  Mail,
  Network,
  Rocket,
  ScanSearch,
  Server,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Workflow,
} from 'lucide-react'

/** A picture for each page on the docs index; a book for any page not listed. */
const ICONS: Record<string, LucideIcon> = {
  summary: Info,
  tutorial: GraduationCap,
  usage: SlidersHorizontal,
  features: Sparkles,
  pwa: Smartphone,
  push: Bell,
  email: Mail,
  oauth: KeyRound,
  architecture: Network,
  rag: ScanSearch,
  database: Database,
  backups: HardDriveDownload,
  'self-hosting': Server,
  deployment: Rocket,
  'ci-cd': Workflow,
  workflow: GitBranch,
}

export function docIcon(slug: string): LucideIcon {
  return ICONS[slug] ?? BookOpen
}
