'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { deleteConversation, renameConversation } from '@/lib/chat/actions'
import { groupConversations, type RecentConversation } from '@/lib/chat/recents'
import { cn } from '@/lib/utils'

/**
 * The Recents list (spec 0026 FR7/FR8).
 *
 * Conversations arrive from the server layout already ordered by activity;
 * grouping into Today / Yesterday / … happens here so the boundaries are a
 * pure, tested function rather than SQL date arithmetic.
 */
export function RecentsList({
  conversations,
  onNavigate,
}: {
  conversations: RecentConversation[]
  onNavigate?: () => void
}) {
  const router = useRouter()
  const params = useParams<{ id?: string }>()
  const activeId = params?.id
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const groups = groupConversations(conversations)

  const commitRename = async (id: string) => {
    const next = draft.trim()
    setRenamingId(null)
    if (next.length === 0) return
    await renameConversation(id, next)
    router.refresh()
  }

  const remove = async (id: string) => {
    await deleteConversation(id)
    // Deleting the conversation you are reading drops you into a new chat.
    if (id === activeId) router.push('/chat')
    router.refresh()
  }

  if (conversations.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">
        Your conversations will appear here.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {groups.map(({ group, conversations: items }) => (
        <div key={group}>
          <h2 className="text-muted-foreground px-3 pb-1 text-xs font-medium">
            {group}
          </h2>
          <ul className="space-y-0.5">
            {items.map((conversation) => {
              const active = conversation.id === activeId
              return (
                <li key={conversation.id} className="group/item relative">
                  {renamingId === conversation.id ? (
                    <div className="flex items-center gap-1 px-1">
                      <Input
                        autoFocus
                        value={draft}
                        aria-label="Conversation title"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter')
                            void commitRename(conversation.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="h-8 text-sm"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0"
                        aria-label="Save title"
                        onClick={() => void commitRename(conversation.id)}
                      >
                        <Check className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0"
                        aria-label="Cancel rename"
                        onClick={() => setRenamingId(null)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Link
                        href={`/chat/${conversation.id}`}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        title={conversation.title}
                        className={cn(
                          'block truncate rounded-md py-2 pr-9 pl-3 text-sm transition-colors',
                          active
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                        )}
                      >
                        {conversation.title}
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Actions for ${conversation.title}`}
                            className="absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setDraft(conversation.title)
                              setRenamingId(conversation.id)
                            }}
                          >
                            <Pencil className="mr-2 size-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => void remove(conversation.id)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
