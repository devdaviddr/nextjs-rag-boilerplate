'use client'

import { useRef, useState } from 'react'
import { Download, FolderOpen, Trash2, Upload } from 'lucide-react'

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FormMessage } from '@/components/auth/field-error'
import {
  deleteFile,
  listMyFiles,
  uploadFile,
  type FileSummary,
} from '@/lib/storage/actions'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

interface FilesPanelProps {
  initialFiles: FileSummary[]
}

export function FilesPanel({ initialFiles }: FilesPanelProps) {
  const [files, setFiles] = useState<FileSummary[]>(initialFiles)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileSummary | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    try {
      const result = await listMyFiles()
      if (result) setFiles(result)
    } catch {
      // Session may have lapsed mid-page; ignore and let the next render redirect.
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.set('file', file)
      const result = await uploadFile(formData)
      if (!result.ok) {
        setError(result.error)
      } else {
        await refresh()
      }
    } catch {
      setError('Upload failed unexpectedly. Please try again.')
    } finally {
      setIsUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    setError(null)
    try {
      const result = await deleteFile(deleteTarget.id)
      if (!result.ok) {
        setError(result.error)
      } else {
        setDeleteTarget(null)
        await refresh()
      }
    } catch {
      setError('Delete failed unexpectedly. Please try again.')
    } finally {
      setIsDeleting(false)
    }
  }

  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            My Files
          </CardTitle>
          <CardDescription>
            {files.length} file{files.length !== 1 ? 's' : ''} ·{' '}
            {formatBytes(totalBytes)} used
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={isUploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          {isUploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          aria-label="Upload a file"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <FormMessage message={error} />}

        {files.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No files uploaded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="max-w-[16rem] truncate">
                      {file.originalName}
                    </TableCell>
                    <TableCell>{formatBytes(file.sizeBytes)}</TableCell>
                    <TableCell>
                      {/* ISO, not toLocaleDateString(): the server's locale
                          and the browser's differ, which broke hydration. */}
                      {new Date(file.createdAt).toISOString().slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" asChild>
                        <a
                          href={`/api/files/${file.id}`}
                          download={file.originalName}
                          aria-label={`Download ${file.originalName}`}
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        aria-label={`Delete ${file.originalName}`}
                        onClick={() => setDeleteTarget(file)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete file</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;
              {deleteTarget?.originalName}
              &rdquo;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
