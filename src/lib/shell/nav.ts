import {
  FileText,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
}

/** Primary navigation shown in the sidebar / mobile drawer. */
export const navItems: NavItem[] = [
  { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { title: 'Knowledge base', href: '/documents', icon: FileText },
  { title: 'Chat', href: '/chat', icon: MessagesSquare },
  { title: 'Settings', href: '/settings', icon: Settings },
]
