import { Activity, BookOpen, FileText, type LucideIcon } from 'lucide-react'

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  /** Shown to admins only; the page checks the role itself too. */
  adminOnly?: boolean
}

/**
 * Destinations in the sidebar, between the "New chat" action above and the
 * Recents list below. Deliberately short: chat is the product, so anything
 * that isn't the chat or its source material belongs in the account menu.
 */
export const navItems: NavItem[] = [
  { title: 'Knowledge bases', href: '/documents', icon: FileText },
  // How the platform works, rendered from docs/*.md (spec 0041).
  { title: 'Docs', href: '/docs', icon: BookOpen },
  // What the RAG pipeline and its agents are doing (spec 0042).
  {
    title: 'Observability',
    href: '/observability',
    icon: Activity,
    adminOnly: true,
  },
]
