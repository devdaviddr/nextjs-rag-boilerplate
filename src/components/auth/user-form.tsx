'use client'

import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, type Resolver } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { RoleSelector } from '@/components/auth/role-selector'
import { createUser, updateUser, assignRoles } from '@/lib/auth/admin-actions'
import {
  createUserSchema,
  updateUserSchema,
  assignRolesSchema,
} from '@/lib/validations/auth'

type FormValues = { name?: string; email?: string; roleIds: string[] }
type FormMode = 'create' | 'edit' | 'roles'

interface UserFormProps {
  mode: FormMode
  open: boolean
  onOpenChange: (open: boolean) => void
  allRoles: Array<{ id: string; name: string }>
  initialData?: {
    id?: string
    name?: string
    email?: string
    roleIds?: string[]
  }
  onSuccess?: () => void
}

// The RHF resolver validates the form fields; the server action re-validates the
// full input (incl. userId) as the source of truth.
const rolesOnlySchema = assignRolesSchema.pick({ roleIds: true })

export function UserForm({
  mode,
  open,
  onOpenChange,
  allRoles,
  initialData,
  onSuccess,
}: UserFormProps) {
  const isCreate = mode === 'create'
  const isEdit = mode === 'edit'
  const isRoles = mode === 'roles'

  const title = isCreate ? 'Add User' : isEdit ? 'Edit User' : 'Assign Roles'
  const description = isCreate
    ? 'Create a new user. They set their password on first login.'
    : isEdit
      ? 'Update user information.'
      : 'Select roles for this user.'

  const [isPending, setIsPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(
      isCreate ? createUserSchema : isEdit ? updateUserSchema : rolesOnlySchema,
    ) as Resolver<FormValues>,
    defaultValues: { name: '', email: '', roleIds: [] },
  })

  // Reload fields when the dialog opens (imperative RHF reset — not setState).
  useEffect(() => {
    if (!open) return
    form.reset({
      name: initialData?.name ?? '',
      email: initialData?.email ?? '',
      roleIds: initialData?.roleIds ?? [],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData?.id])

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    setIsPending(true)
    try {
      if (isCreate) {
        const result = await createUser({
          name: values.name ?? '',
          email: values.email ?? '',
          roleIds: values.roleIds,
        })
        if (!result.ok) {
          setFormError(result.error)
          return
        }
        const created = result.data
        // Show the one-time invite link; the dialog stays open until "Done".
        setEmailSent(created.emailSent)
        setInviteUrl(
          `${window.location.origin}/register?invite=${encodeURIComponent(
            created.inviteToken,
          )}&email=${encodeURIComponent(created.email)}`,
        )
        return
      } else if (isEdit && initialData?.id) {
        const result = await updateUser(initialData.id, {
          name: values.name,
          email: values.email,
          roleIds: values.roleIds,
        })
        if (!result.ok) {
          setFormError(result.error)
          return
        }
      } else if (isRoles && initialData?.id) {
        const result = await assignRoles({
          userId: initialData.id,
          roleIds: values.roleIds,
        })
        if (!result.ok) {
          setFormError(result.error)
          return
        }
      }
      onSuccess?.()
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setIsPending(false)
    }
  })

  function handleOpenChange(next: boolean) {
    if (!next) {
      setFormError(null)
      setInviteUrl(null)
      setEmailSent(false)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{inviteUrl ? 'User created' : title}</DialogTitle>
          <DialogDescription>
            {inviteUrl
              ? emailSent
                ? 'An invite email was sent. You can also copy the link below.'
                : 'Send this one-time invite link so they can set a password.'
              : description}
          </DialogDescription>
        </DialogHeader>

        {inviteUrl ? (
          <div className="space-y-3">
            {emailSent && (
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                ✓ Invite email sent
              </p>
            )}
            <div className="flex gap-2">
              <Input
                readOnly
                value={inviteUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigator.clipboard?.writeText(inviteUrl)}
              >
                Copy
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Expires in 7 days and can be used once.
            </p>
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={() => onSuccess?.()}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              {!isRoles && (
                <>
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Ada Lovelace"
                            {...field}
                            disabled={isPending}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="user@example.com"
                            {...field}
                            disabled={isPending}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              <FormField
                control={form.control}
                name="roleIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {isEdit ? 'Roles (leave as-is to keep)' : 'Roles'}
                    </FormLabel>
                    <FormControl>
                      <RoleSelector
                        value={field.value ?? []}
                        onChange={field.onChange}
                        options={allRoles}
                        disabled={isPending}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {formError && (
                <p className="text-destructive text-sm" role="alert">
                  {formError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? 'Saving…' : isCreate ? 'Create' : 'Save'}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
