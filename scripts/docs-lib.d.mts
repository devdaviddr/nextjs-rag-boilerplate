export const REPO_URL: string
export const DOC_SECTIONS: {
  title: string
  description: string
  slugs: string[]
}[]
export const DOC_ORDER: string[]
export function unmappedDocs(slugsOnDisk: string[]): {
  missingFromIndex: string[]
  missingOnDisk: string[]
}
export function headingText(raw: string): string
export function headings(
  markdown: string,
): { depth: number; text: string; id: string }[]
export function docTitle(markdown: string, slug: string): string
export function docSummary(markdown: string): string
export function stripBackLinks(markdown: string): string
export function stripTitle(markdown: string): string
export function searchEntries(
  markdown: string,
): { id: string; heading: string; depth: number; text: string }[]
export type ResolvedHref =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'doc'; slug: string; href: string }
  | { kind: 'image'; href: string }
  | { kind: 'repo'; path: string; href: string }
export function resolveDocHref(href: string, ref?: string): ResolvedHref
export function markdownLinks(
  markdown: string,
): { href: string; line: number }[]
