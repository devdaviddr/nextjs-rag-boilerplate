'use client'

import { useState } from 'react'

import { FormMessage } from '@/components/auth/field-error'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createKnowledgeBase,
  type KnowledgeBaseSummary,
} from '@/lib/rag/kb-actions'

/**
 * "New knowledge base" dialog (spec 0028 UX).
 *
 * Shared between the `/documents` switcher and the composer's zero-KB empty
 * state — the spec calls for both to open "the same create dialog" rather
 * than two forms that can drift apart.
 */
export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (kb: KnowledgeBaseSummary) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const reset = () => {
    setName('')
    setDescription('')
    setError(null)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const result = await createKnowledgeBase({
        name,
        description: description.trim() || undefined,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onCreated(result.data)
      onOpenChange(false)
      reset()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New knowledge base</DialogTitle>
            <DialogDescription>
              Documents live in exactly one knowledge base. You can move them
              between knowledge bases later without re-uploading.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {error && <FormMessage message={error} />}
            <div className="space-y-2">
              <Label htmlFor="kb-name">Name</Label>
              <Input
                id="kb-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Staff handbook"
                maxLength={80}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-description">Description (optional)</Label>
              <Input
                id="kb-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What lives in here"
                maxLength={280}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || name.trim() === ''}>
              {isSubmitting ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
