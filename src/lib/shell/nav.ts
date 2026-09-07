import { FileText, type LucideIcon } from 'lucide-react'

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
}

/**
 * Destinations in the sidebar, between the "New chat" action above and the
 * Recents list below. Deliberately short: chat is the product, so anything
 * that isn't the chat or its source material belongs in the account menu.
 */
export const navItems: NavItem[] = [
  { title: 'Knowledge bases', href: '/documents', icon: FileText },
]
