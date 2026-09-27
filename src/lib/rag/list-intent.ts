/**
 * Is this question asking which documents there are? (#168)
 *
 * Such a question is about the list, not about what any passage says, so a
 * search cannot answer it: no passage is about the set of documents. It is
 * answered with the built-in `list_documents` tool instead, with no search
 * and no planner call.
 *
 * Pure and free, like `route-intent.ts`, and narrow on purpose. A question
 * that asks which documents SAY something ("which documents mention
 * overtime?") is a content question and must search, so any content word
 * rules this out. A list question this misses still reaches the tool through
 * the planner, which is always offered it.
 */

const DOCS = String.raw`(?:documents?|docs?|files?|sources?|pdfs?|uploads?|knowledge ?bases?)`

const LIST_QUESTION = new RegExp(
  [
    // "what documents do you have", "which files can you see", "what docs are there"
    String.raw`\b(?:what|which)\s+(?:\w+\s+){0,2}${DOCS}\s+(?:do|does|can|could|are|is|have|did)\b`,
    // "list my documents", "show me all the files", "name the sources"
    String.raw`\b(?:list|show|name|enumerate)\s+(?:me\s+)?(?:(?:all|the|my|your|our|of|every|each|available)\s+)*${DOCS}\b`,
    // "how many documents are there"
    String.raw`\bhow many\s+${DOCS}\b`,
    // "what do you have access to", "what can you see", "what have I uploaded"
    String.raw`\bwhat\s+(?:do|can)\s+you\s+(?:have access to|see|access|read)\b`,
    String.raw`\bwhat\s+(?:have|did)\s+i\s+upload(?:ed)?\b`,
    // "what's in my knowledge base", "what is in this knowledge base"
    String.raw`\bwhat(?:'s|\s+is)\s+in\s+(?:my|this|the|our)\s+knowledge ?bases?\b`,
    // "documents you have access to", "files available to you"
    String.raw`\b${DOCS}\s+(?:do you have|you have(?: access to)?|you can (?:see|access|read)|available)\b`,
  ].join('|'),
  'i',
)

/** Words that make it a question about content, which must search. */
const ABOUT_CONTENT =
  /\b(?:mention(?:s|ed)?|say(?:s)?|said|cover(?:s|ed)?|discuss(?:es|ed)?|contain(?:s|ed|ing)?|talk(?:s)? about|describ(?:e|es|ed)|refer(?:s|red)? to|about|regarding|concerning|on the (?:topic|subject) of|explain(?:s)?|where|when|why|how (?:do|does|much|long|often)|with the|that has|that have|need(?:s|ed)?|should|must|require[sd]?|required|submit|bring|sign|for (?:a|an|the|my))\b/i

export function hasDocumentListIntent(question: string): boolean {
  const q = question.trim()
  if (q.length > 160) return false
  return LIST_QUESTION.test(q) && !ABOUT_CONTENT.test(q)
}
