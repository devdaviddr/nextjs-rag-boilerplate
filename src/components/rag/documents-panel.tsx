'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, FolderInput, RotateCw, Trash2, Upload } from 'lucide-react'

import { FormMessage } from '@/components/auth/field-error'
import { Badge } from '@/components/ui/badge'
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
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  deleteDocument,
  listMyDocuments,
  retryDocument,
  uploadDocument,
  type DocumentSummary,
} from '@/lib/rag/actions'
import { moveDocument, type KnowledgeBaseSummary } from '@/lib/rag/kb-actions'

const IN_FLIGHT = new Set(['pending', 'extracting', 'embedding'])

const STATUS_LABEL: Record<DocumentSummary['status'], string> = {
  pending: 'Queued',
  extracting: 'Reading',
  embedding: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
}

function statusVariant(
  status: DocumentSummary['status'],
): 'default' | 'secondary' | 'destructive' {
  if (status === 'ready') return 'default'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}

interface DocumentsPanelProps {
  knowledgeBaseId: string
  knowledgeBases: KnowledgeBaseSummary[]
  initialDocuments: DocumentSummary[]
  configured: boolean
  /** Document cracking is on, so scanned PDFs are read rather than refused. */
  cracking: boolean
}

export function DocumentsPanel({
  knowledgeBaseId,
  knowledgeBases,
  initialDocuments,
  configured,
  cracking,
}: DocumentsPanelProps) {
  const [documents, setDocuments] = useState(initialDocuments)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocumentSummary | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Every other knowledge base the user owns — the "Move to…" candidates.
  const otherKnowledgeBases = knowledgeBases.filter(
    (kb) => kb.id !== knowledgeBaseId,
  )

  const refresh = useCallback(async () => {
    try {
      setDocuments(await listMyDocuments(knowledgeBaseId))
    } catch {
      // Session may have lapsed mid-page; the next navigation redirects.
    }
  }, [knowledgeBaseId])

  // Ingestion runs out-of-band, so the only way the UI learns it finished is
  // to ask. Polling stops as soon as nothing is in flight.
  const hasInFlight = documents.some((d) => IN_FLIGHT.has(d.status))
  useEffect(() => {
    if (!hasInFlight) return
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [hasInFlight, refresh])

  const handleUpload = async (file: File) => {
    setError(null)
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      // Upload always targets the KB whose page this is — there is no picker
      // (spec 0028 FR3), so the target is never ambiguous.
      formData.append('knowledgeBaseId', knowledgeBaseId)
      const result = await uploadDocument(formData)
      if (!result.ok) setError(result.error)
      await refresh()
    } finally {
      setIsUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const handleRetry = async (id: string) => {
    setError(null)
    const result = await retryDocument(id)
    if (!result.ok) setError(result.error)
    await refresh()
  }

  // Re-tags rows only — no re-extraction, no re-chunking, no re-embedding
  // (spec 0028 FR4). The document simply drops out of this list on refresh.
  const handleMove = async (
    documentId: string,
    targetKnowledgeBaseId: string,
  ) => {
    setError(null)
    const result = await moveDocument(documentId, targetKnowledgeBaseId)
    if (!result.ok) setError(result.error)
    await refresh()
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      const result = await deleteDocument(deleteTarget.id)
      if (!result.ok) setError(result.error)
      await refresh()
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your documents</CardTitle>
        <CardDescription>
          {cracking
            ? 'PDFs, including scanned ones. Pages with tables, figures or an unusual layout are read page by page, which takes longer than a plain text PDF.'
            : "PDFs with selectable text. Scanned documents aren't supported yet — they have no text layer to index."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured && (
          <FormMessage message="Document chat isn't configured on this deployment. Set NVIDIA_API_KEY to enable uploads and chat." />
        )}
        {error && <FormMessage message={error} />}

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            aria-label="Upload a PDF"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleUpload(file)
            }}
          />
          <Button
            type="button"
            disabled={isUploading || !configured}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-2 size-4" />
            {isUploading ? 'Uploading…' : 'Upload PDF'}
          </Button>
        </div>

        {documents.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <FileText className="size-8 opacity-50" />
            <p>No documents yet. Upload a PDF to get started.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Pages</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">
                    {doc.title}
                    {doc.error && (
                      <p className="text-destructive mt-1 text-xs font-normal">
                        {doc.error}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(doc.status)}>
                      {STATUS_LABEL[doc.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {doc.pageCount ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {doc.chunkCount || '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {doc.status === 'failed' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Retry ${doc.title}`}
                          onClick={() => void handleRetry(doc.id)}
                        >
                          <RotateCw className="size-4" />
                        </Button>
                      )}
                      {otherKnowledgeBases.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Move ${doc.title}`}
                            >
                              <FolderInput className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Move to</DropdownMenuLabel>
                            {otherKnowledgeBases.map((kb) => (
                              <DropdownMenuItem
                                key={kb.id}
                                onSelect={() => void handleMove(doc.id, kb.id)}
                              >
                                {kb.name}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${doc.title}`}
                        onClick={() => setDeleteTarget(doc)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this document?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.title} and everything indexed from it will be
              removed. This can&apos;t be undone.
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
    </Card>
  )
}
