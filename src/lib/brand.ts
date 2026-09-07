/**
 * Product identity, in one place.
 *
 * The name was previously hard-coded in four files (root layout, PWA manifest,
 * landing page, app shell), which is how a rename gets half-done. Anything
 * user-visible reads from here.
 */
export const APP_NAME = 'Rag Boilerplate'

/** Short form for the PWA manifest and the `%s · …` title template. */
export const APP_SHORT_NAME = 'Rag Boilerplate'

/** One-line description used for metadata and the landing page. */
export const APP_DESCRIPTION =
  'Upload a PDF knowledge base and chat with your documents, with a citation for every answer.'

/** Where a signed-in user lands. Chat is the product; there is no dashboard. */
export const HOME_PATH = '/chat'
