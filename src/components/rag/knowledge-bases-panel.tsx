'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Check,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'

import { FormMessage } from '@/components/auth/field-error'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { CreateKnowledgeBaseDialog } from '@/components/rag/create-knowledge-base-dialog'
import {
  deleteKnowledgeBase,
  listMyKnowledgeBases,
  renameKnowledgeBase,
  type KnowledgeBaseSummary,
} from '@/lib/rag/kb-actions'

/**
 * `/documents` — the knowledge-base switcher (spec 0028 UX).
 *
 * Rename follows `recents-list.tsx`'s inline-`Input` pattern exactly. Delete
 * does NOT — that list deletes instantly, but a knowledge base takes its
 * documents with it, so this one confirms first (spec 0028 UX / FR2).
 */
export function KnowledgeBasesPanel({
  initialKnowledgeBases,
}: {
  initialKnowledgeBases: KnowledgeBaseSummary[]
}) {
  const router = useRouter()
  const [knowledgeBases, setKnowledgeBases] = useState(initialKnowledgeBases)

  /**
   * Adopt a newer server payload for this list.
   *
   * Seeding `useState` from a prop captures it once, so a `router.refresh()`
   * after a rename or a delete re-rendered the server tree and changed
   * nothing here. The same staleness arrives from Next's Router Cache, which
   * replays a route's payload verbatim on a BACK navigation.
   */
  const [lastInitial, setLastInitial] = useState(initialKnowledgeBases)
  if (initialKnowledgeBases !== lastInitial) {
    setLastInitial(initialKnowledgeBases)
    setKnowledgeBases(initialKnowledgeBases)
  }
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseSummary | null>(
    null,
  )
  const [isDeleting, setIsDeleting] = useState(false)

  const refresh = async () => {
    try {
      setKnowledgeBases(await listMyKnowledgeBases())
    } catch {
      // Session may have lapsed mid-page; the next navigation redirects.
    }
  }

  const commitRename = async (id: string) => {
    const next = draft.trim()
    setRenamingId(null)
    if (next.length === 0) return
    const result = await renameKnowledgeBase(id, next)
    if (!result.ok) setError(result.error)
    await refresh()
    router.refresh()
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const result = await deleteKnowledgeBase(deleteTarget.id)
      if (!result.ok) setError(result.error)
      await refresh()
      router.refresh()
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="space-y-4">
      {error && <FormMessage message={error} />}

      <Button type="button" onClick={() => setCreateOpen(true)}>
        <Plus className="mr-2 size-4" />
        New knowledge base
      </Button>

      {knowledgeBases.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm">
          <FileText className="size-8 opacity-50" />
          <p>
            No knowledge bases yet. Create one to start uploading documents.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {knowledgeBases.map((kb) => (
            <Card key={kb.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  {renamingId === kb.id ? (
                    <div className="flex flex-1 items-center gap-1">
                      <Input
                        autoFocus
                        value={draft}
                        aria-label="Knowledge base name"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(kb.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="h-8 text-sm"
                        maxLength={80}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0"
                        aria-label="Save name"
                        onClick={() => void commitRename(kb.id)}
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
                      <div className="min-w-0">
                        <CardTitle className="truncate">
                          <Link
                            href={`/documents/${kb.id}`}
                            className="hover:underline"
                          >
                            {kb.name}
                          </Link>
                        </CardTitle>
                        {kb.description && (
                          <CardDescription className="mt-1 line-clamp-2">
                            {kb.description}
                          </CardDescription>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Actions for ${kb.name}`}
                            className="size-7 shrink-0"
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setDraft(kb.name)
                              setRenamingId(kb.id)
                            }}
                          >
                            <Pencil className="mr-2 size-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setDeleteTarget(kb)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/documents/${kb.id}`}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-3 text-sm"
                >
                  <span>
                    {kb.documentCount}{' '}
                    {kb.documentCount === 1 ? 'document' : 'documents'}
                  </span>
                  <span>{kb.readyCount} ready</span>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(kb) => {
          setKnowledgeBases((prev) => [...prev, kb])
          router.refresh()
        }}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this knowledge base?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.name} and every document in it —{' '}
              {deleteTarget?.documentCount ?? 0}{' '}
              {deleteTarget?.documentCount === 1 ? 'document' : 'documents'} —
              will be deleted. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void handleDelete()}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
